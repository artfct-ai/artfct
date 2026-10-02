import { harnessAdapter } from "@artfct-ai/adapters/harness/clients";
import { HARNESSES, type Harness } from "@artfct-ai/adapters/harness/types";
import { isFinishedState, unfinishedBlockers } from "@artfct-ai/adapters/tracker/issues";
import { ARTIFACT_KINDS } from "@artfct-ai/contracts/types";
import { tool } from "ai";
import { z } from "zod";
import { parseDocumentOptions } from "../../../artifact/options";
import type { ArtifactTarget } from "../../../artifact/types";
import { resolveStage } from "../../../config/stage";
import { humansAccepted } from "./humans-accepted";
import { GATEWAY_HARNESS, type RuntimeRequest } from "../../message/requested-runtime";
import { humansSelected } from "./humans-selected";
import { findBinding } from "../../../db/bindings";
import { createDb } from "../../../db/client";
import {
  cancelTask,
  completeJob,
  startJob,
  type CompleteOutcome,
  type JobInput,
  type JobIssue,
} from "../../../workflow/lifecycle";
import { stageContinuesArtifact } from "../../../workflow/artifact";
import { artifactRefKey, jobInputFor, jobInputKey } from "../../../workflow/store/input-key";
import { isTaskFinished } from "../../../workflow/store/state";
import type { ArtifactRow, JobRow } from "../../../workflow/store/tasks";
import type { WorkflowRuntime } from "../../../workflow/types";
import { endedWorkflowRefusal } from "../plan";

const jobIdField = z.string().describe("the job id, for example wf_abc-2");

/** How the agent runs jobs through their stages. Kept next to the tools that start and end them. */
export const TASK_RULES = `## Job & Stage Execution Protocol

### Stage Lifecycle
* **Evaluate** stage conditions before execution; execute only when the precondition holds.
* **Call** \`start_job\` following \`set_plan\` with stage identity and brief (scope, acceptance criteria, links, context).
* **Call** \`set_plan\` immediately after a stage outcome resolves a condition.
* **Advance** to the next stage only when all active stage jobs are complete.

### Tracker Issue Ingestion
* **Query** issues using \`ready_issues\` with project ID or via the tracker integration tools.
* **Dispatch** ready issues 1:1 via \`start_job(issue, brief)\`.
* **Throttle** job execution strictly to available concurrency slots.
* **Fill** released slots immediately with the next ready issues.
* **Advance** stage only after the tracker confirms zero open issues remain.

### Human Review Handling
Evaluate user replies and reactions (e.g., an approving emoji) against the following states:

* **APPROVED** ("looks good", "ship it", thumbs up, proceed directives):
  * Call \`complete_job\`.
  * Call \`start_job\` for the subsequent stage with a brief linking approved assets.
* **REVISION_REQUESTED** (change requests, feedback, bug reports):
  * Forward feedback to the author task via \`prompt_task\`.
* **AMBIGUOUS** (unclear intent):
  * Halt and emit exactly one clarifying question.

### Pull Request States
* **MERGED**: Call \`complete_job\` once a person or a note says the pull request merged. It asks the code host live, so a merge whose event was lost still counts, and it refuses a pull request that is not merged.
* **CLOSED_UNMERGED**: Prompt user with a binary decision: retry on a new branch or abandon.
* **OPEN_WITHOUT_AUTHOR** (its job was cancelled or failed): Call \`start_job\` with \`artifact\` set to the pull request link. The new job continues it on its branch. Never ask to close it first.

### Invariants & Exclusions
* **Ignore Unavailable Issues**: Never assign issues that are blocked, closed, or already bound to an active job.
* **Enforce Concurrency**: Never start more jobs than available slot capacity.
* **Omit Redundant Context**: Never duplicate system-injected stage instructions in job briefs.
* **Prevent Duplicate Execution**: Never repeat operations listed in "What the system already did" logs.
* **Prohibit Speculative Completion**: Never call \`complete_job\` on a pull request job before anyone reports a merge.`;

/** The tool that starts a job. Its board is the reply to a request for work. */
export const START_JOB = "start_job";

/**
 * What a turn gives the start tools beyond the people's messages. `requestText` identifies an ad
 * hoc job started in the turn. `runtimeRequest` settles to the model a message named, or null.
 */
export type StartTurn = {
  requestText?: string;
  runtimeRequest?: Promise<RuntimeRequest | null>;
};

/** Tools that start jobs and end them. `personMessages` are what the people wrote in this turn. */
export function startTools(
  workflow: WorkflowRuntime,
  personMessages: string[] = [],
  turn: StartTurn = {},
) {
  const requestText = turn.requestText ?? personMessages.join("\n");
  const runtimeRequest = turn.runtimeRequest ?? Promise.resolve(null);
  return {
    [START_JOB]: tool({
      description:
        "Start a job for a stage. Its author task runs in a sandbox, or as one model call on a stage with model execution. The brief is what the harness reads first: goal, acceptance criteria, links, context. The stage instructions are added by the system. Name the tracker issue when the job works on one. Name the artifact when the request points at one that no job of this workflow produced, such as a design doc written elsewhere or an open pull request. Name it too for an open pull request whose job was cancelled or failed. A job that is given a pull request in a stage that produces one continues it: it works on the branch of that pull request and opens no other. Refused when the workflow has ended, every slot is busy, the issue is blocked by an unfinished issue, the artifact link is not on a configured host, the pull request to continue is closed or its author task is unfinished, a job already works on the same input, an earlier job on the same input left an artifact the host still holds, or a stage with model execution or a choice ending has no document host. The input is the issue, else the artifact. With neither it is the artifact of the latest completed job, or else the message that asked for the job.",
      inputSchema: z.object({
        stage: z.string().describe("a stage name from the config"),
        brief: z.string().min(1),
        issue: z.string().optional().describe("tracker issue identifier (ENG-42) or id"),
        artifact: z
          .string()
          .optional()
          .describe(
            "the link to the artifact the job works from, when the request points at one that no job of this workflow produced, or to the open pull request it continues: a page, a pull request, or an issue set",
          ),
        title: z.string().optional().describe("short title for the branch name"),
        harness: z
          .enum(HARNESSES)
          .optional()
          .describe(
            "run this job's author on another harness than the stage's, when the issue's labels ask for one",
          ),
        model: z
          .string()
          .optional()
          .describe(
            "run this job's author on another model than the stage's, when the issue's labels ask for one, named as the config names models",
          ),
      }),
      execute: async (input) => {
        const requested = withRequestedRuntime(workflow, input, await runtimeRequest);
        const started = await start(workflow, requested.input, requestText);
        return requested.note ? `${started} ${requested.note}` : started;
      },
    }),
    complete_job: tool({
      description:
        "Mark a job done once its work is accepted: the humans said the document is good, or the pull request is merged. A pull request must be merged. The code host is asked, so a merge whose event was lost still counts. Any other artifact must be accepted by a person's message in this turn, and that message is checked. On a stage with a choice ending, pass the option a person's message in this turn selects, as its page lists it. The page and the message are checked, and the job keeps the selection. Tears the sandbox down and frees the slot.",
      inputSchema: z.object({
        job_id: jobIdField,
        result: z.string(),
        option: z
          .string()
          .optional()
          .describe(
            "on a stage with a choice ending: the selected option, exactly as the page lists it under its options heading",
          ),
      }),
      execute: ({ job_id, result, option }) =>
        complete(workflow, { jobId: job_id, result, option, personMessages }),
    }),
    cancel_job: tool({
      description:
        "Cancel a job: its author or researcher task, any running refiner run, and their sandboxes. The board closes. The workflow stays open, so its issue can start again.",
      inputSchema: z.object({ job_id: jobIdField, reason: z.string() }),
      execute: ({ job_id, reason }) => cancel(workflow, job_id, reason),
    }),
  };
}

/** What start_job takes. */
export type StartInput = {
  stage: string;
  brief: string;
  issue?: string;
  artifact?: string;
  title?: string;
  harness?: Harness;
  model?: string;
};

/**
 * The start input with the runtime a person's message requested in place of the label args, and
 * what the result tells the agent about it. A stage whose author is one model call takes only a
 * gateway model.
 */
export function withRequestedRuntime(
  workflow: WorkflowRuntime,
  input: StartInput,
  request: RuntimeRequest | null,
): { input: StartInput; note: string | null } {
  if (!request) return { input, note: null };
  if (request.kind === "unresolved") {
    const closest = request.closest.length ? ` The closest: ${request.closest.join(", ")}.` : "";
    return {
      input,
      note: `The person named a model that matched none clearly, so the job runs without it.${closest} Ask the person which model they meant.`,
    };
  }
  const { harness, model } = request.runtime;
  const definition = workflow
    .workflowDefinition()
    .stages.find((candidate) => candidate.name === input.stage);
  if (!definition) return { input, note: null };
  if (resolveStage(workflow.config(), definition).author.produce.execution !== "model") {
    return {
      input: { ...input, harness, model },
      note: `Its author runs ${model} on ${harness}, as the person asked.`,
    };
  }
  if (harness === GATEWAY_HARNESS) {
    return {
      input: { ...input, harness: undefined, model },
      note: `Its author runs on ${model}, as the person asked.`,
    };
  }
  return {
    input,
    note: `Stage ${input.stage} runs its author as one model call on the gateway, and ${model} runs only on ${harness}, so the job runs the stage's model.`,
  };
}

/** The slot guard. Null when a job may start. */
export function slotRefusal(workflow: WorkflowRuntime): string | null {
  const { state } = workflow;
  const active = workflow.store
    .activeAuthorAndResearcherTasks()
    .map((task) => workflow.store.requireJob(task.job_id));
  if (active.length < state.concurrency) return null;
  const ids = active.map((job) => job.job_id).join(", ");
  return `All ${state.concurrency} slots are busy (${ids}). Wait for a job to complete.`;
}

/** How a refusal names the input artifact of a job. */
function inputName(input: JobInput): string {
  if (input.kind === "issue") return input.issue.key;
  if (input.kind === "target") return `the ${input.target.ref.kind} ${input.target.url}`;
  if (input.kind === "artifact") return `the artifact of job ${input.jobId}`;
  return "the same request";
}

/** Refuse when a job whose author or researcher task is unfinished works from the input artifact. */
export function unfinishedJobRefusal(workflow: WorkflowRuntime, input: JobInput): string | null {
  const inputKey = jobInputKey(input);
  for (const job of workflow.store.jobs()) {
    if (job.input_key !== inputKey) continue;
    const task = workflow.store.authorOrResearcherTaskOf(job.job_id);
    if (isTaskFinished(task.status)) continue;
    return `Job ${job.job_id} already works on ${inputName(input)} (${task.status}).`;
  }
  return null;
}

/**
 * Refuse when a finished job on the same input artifact left an output artifact the host still
 * holds. A removal the host never reported is recorded here. A job that left its own input
 * artifact behind continued it, so the next job may continue it too.
 */
async function existingOutputRefusal(
  workflow: WorkflowRuntime,
  input: JobInput,
): Promise<string | null> {
  const inputKey = jobInputKey(input);
  for (const job of workflow.store.jobs()) {
    if (job.input_key !== inputKey) continue;
    const artifact = workflow.store.artifact(job.job_id);
    if (!artifact || artifact.status === "removed") continue;
    const author = workflow.store.authorTaskOf(job.job_id);
    if (!isTaskFinished(author.status)) continue;
    if (artifactRefKey({ ref: artifact.ref, url: artifact.external_url }) === inputKey) continue;
    if (await removedOnHost(workflow, artifact)) continue;
    const held = `Job ${job.job_id} (${author.status}) already produced ${artifact.external_url} from ${inputName(input)}, and the host still holds it (${artifact.status}).`;
    if (artifact.status !== "accepted" && workflow.artifact(artifact.kind).branch) {
      return `${held} To continue it, call start_job with artifact set to that link and no issue. A new job on ${inputName(input)} itself can start once that artifact is removed on the host.`;
    }
    return `${held} A new job would conflict with it. Tell the humans. A new job can start once that artifact is removed on the host.`;
  }
  return null;
}

/** Why this workflow still holds an input artifact: a job works from it, or an output artifact for it exists. */
export async function heldInputRefusal(
  workflow: WorkflowRuntime,
  input: JobInput,
): Promise<string | null> {
  return unfinishedJobRefusal(workflow, input) ?? existingOutputRefusal(workflow, input);
}

/** Refuse when the issue routes to another workflow that still holds it. That workflow decides. */
async function heldElsewhereRefusal(
  workflow: WorkflowRuntime,
  issue: JobIssue,
): Promise<string | null> {
  const binding = { source: "tracker_issue" as const, external_id: issue.id };
  const owner = await findBinding(createDb(workflow.env.DB), binding);
  if (!owner || owner === workflow.state.workflow_id) return null;
  const held = await workflow.env.Workflow.getByName(owner).heldInput({ kind: "issue", issue });
  return held ? `Workflow ${owner} holds ${issue.key}. ${held}` : null;
}

async function removedOnHost(workflow: WorkflowRuntime, artifact: ArtifactRow): Promise<boolean> {
  if (artifact.status === "accepted") return false;
  const removed = await workflow.artifact(artifact.kind).removed?.({
    ref: artifact.ref,
    url: artifact.external_url,
  });
  if (!removed) return false;
  workflow.store.advanceArtifact(artifact.job_id, ["drafted", "ready"], "removed");
  workflow.log(null, `the host removed the artifact of job ${artifact.job_id}. recorded.`);
  return true;
}

/** The branch of the artifact a job continues, or why it cannot. Null for a job that gets its own branch. */
async function continuedBranch(
  workflow: WorkflowRuntime,
  stageName: string,
  target: ArtifactTarget | null,
): Promise<{ branch: string | null } | { refusal: string }> {
  const definition = workflow
    .workflowDefinition()
    .stages.find((candidate) => candidate.name === stageName);
  if (!target || !definition) return { branch: null };
  const stage = resolveStage(workflow.config(), definition);
  if (!stageContinuesArtifact(stage, target.ref)) return { branch: null };
  const key = artifactRefKey(target);
  const holder = workflow.store
    .artifacts()
    .filter((row) => artifactRefKey({ ref: row.ref, url: row.external_url }) === key)
    .map((row) => workflow.store.authorTaskOf(row.job_id))
    .find((author) => !isTaskFinished(author.status));
  if (holder) {
    return {
      refusal: `Job ${holder.job_id} still works on ${target.url} (${holder.status}). Send its author what is needed with prompt_task.`,
    };
  }
  const branch = await workflow
    .artifact(stage.artifact)
    .branch?.(target.ref)
    .catch((error: unknown) => {
      workflow.log(null, `branch lookup of ${target.url} failed: ${String(error).slice(0, 200)}`);
      return null;
    });
  if (!branch) {
    return {
      refusal: `${target.url} is closed or comes from a fork, so no job can continue it.`,
    };
  }
  return { branch };
}

/** Every guard that needs no external call. Null when a job may start. */
function startRefusal(workflow: WorkflowRuntime, input: StartInput): string | null {
  const ended = endedWorkflowRefusal(workflow);
  if (ended) return ended;
  const definition = workflow
    .workflowDefinition()
    .stages.find((candidate) => candidate.name === input.stage);
  if (!definition) return `Unknown stage ${input.stage}. Use a name from the config.`;
  const { produce } = resolveStage(workflow.config(), definition).author;
  const executionRefusal =
    produce.execution === "model"
      ? modelExecutionRefusal(definition.name, input.harness)
      : harnessAdapter(input.harness ?? produce.harness).modelRefusal(input.model ?? produce.model);
  if (executionRefusal) return executionRefusal;
  return slotRefusal(workflow);
}

/** Refuse a harness for a stage whose author runs as a model call. */
function modelExecutionRefusal(stage: string, harness: Harness | undefined): string | null {
  if (!harness) return null;
  return `Stage ${stage} runs its author as one model call, with no harness. Start it without a harness.`;
}

/**
 * Refuse a stage with model execution or a choice ending when the workflow has no document host.
 */
export async function documentHostRefusal(
  workflow: WorkflowRuntime,
  stageName: string,
): Promise<string | null> {
  const definition = workflow
    .workflowDefinition()
    .stages.find((candidate) => candidate.name === stageName);
  if (definition?.ending === "choice" && !(await workflow.docs())) {
    return `Stage ${stageName} ends on a choice read from its page on the document host, and this workflow has none.`;
  }
  if (definition?.author.produce.execution !== "model" || (await workflow.docs())) return null;
  return `Stage ${stageName} writes its page on the document host, and this workflow has none.`;
}

/** Resolve the issue in the tracker and refuse when it is finished or blocked. */
async function resolveIssue(
  workflow: WorkflowRuntime,
  idOrKey: string,
): Promise<JobIssue | string> {
  const tracker = await workflow.tracker();
  if (!tracker) return { id: idOrKey, key: idOrKey, title: idOrKey, team_id: null, started: false };
  const issue = await tracker.issue(idOrKey);
  if (!issue) return `The tracker has no issue ${idOrKey}.`;
  if (isFinishedState(issue.state.type)) return `${issue.identifier} is ${issue.state.name}.`;
  const blockers = unfinishedBlockers(issue).map((blocker) => blocker.identifier);
  if (blockers.length) return `${issue.identifier} is blocked by ${blockers.join(", ")}.`;
  return {
    id: issue.id,
    key: issue.identifier,
    title: issue.title,
    team_id: issue.team_id,
    started: issue.state.type === "started",
  };
}

/** Resolve the link through every artifact kind and refuse one that none claims. */
async function resolveTarget(
  workflow: WorkflowRuntime,
  url: string,
): Promise<ArtifactTarget | string> {
  for (const kind of ARTIFACT_KINDS) {
    const target = await workflow.artifact(kind).detect(url);
    if (target) return target;
  }
  return `The link ${url} is not an artifact on a configured host.`;
}

async function start(
  workflow: WorkflowRuntime,
  input: StartInput,
  requestText: string,
): Promise<string> {
  const early = startRefusal(workflow, input) ?? (await documentHostRefusal(workflow, input.stage));
  if (early) return early;
  if (input.issue && input.artifact) return "Name the issue or the artifact, not both.";
  const issue = input.issue ? await resolveIssue(workflow, input.issue) : null;
  if (typeof issue === "string") return issue;
  const target = input.artifact ? await resolveTarget(workflow, input.artifact) : null;
  if (typeof target === "string") return target;
  const jobInput = jobInputFor(workflow, { issue, target }, requestText);
  const elsewhere = issue ? await heldElsewhereRefusal(workflow, issue) : null;
  if (elsewhere) return elsewhere;
  const held = await heldInputRefusal(workflow, jobInput);
  if (held) return held;
  const continued = await continuedBranch(workflow, input.stage, target);
  if ("refusal" in continued) return continued.refusal;
  const hostRefusal = await documentHostRefusal(workflow, input.stage);
  if (hostRefusal) return hostRefusal;
  // Other start_job calls of the same step can run during the awaits above.
  const late = startRefusal(workflow, input) ?? unfinishedJobRefusal(workflow, jobInput);
  if (late) return late;
  const { stage, brief, title, harness, model } = input;
  const job = await startJob(workflow, {
    stage,
    brief,
    title,
    harness,
    model,
    input: jobInput,
    continued_branch: continued.branch ?? undefined,
  });
  if (!job) return "The job could not start. See the failure posted to the channels.";
  const task = workflow.store.authorOrResearcherTaskOf(job.job_id);
  const branch = job.branch ? ` on branch ${job.branch}` : "";
  const on = job.issue_key ? ` for ${job.issue_key}` : "";
  if (target && continued.branch) {
    return `Started job ${job.job_id} for stage ${job.stage}${branch}. It continues ${target.url}. Its ${task.role} task is ${task.task_id}.`;
  }
  return `Started job ${job.job_id} for stage ${job.stage}${on}${branch}. Its ${task.role} task is ${task.task_id}.`;
}

type CompleteInput = {
  jobId: string;
  result: string;
  option: string | undefined;
  personMessages: string[];
};

async function complete(
  workflow: WorkflowRuntime,
  { jobId, result, option, personMessages }: CompleteInput,
): Promise<string> {
  const job = workflow.store.job(jobId);
  if (!job) return `Job ${jobId} does not exist.`;
  const task = workflow.store.authorOrResearcherTaskOf(jobId);
  if (isTaskFinished(task.status)) {
    return `Job ${jobId} is already over: its ${task.role} task is ${task.status}. A finished task keeps its status.`;
  }
  const author = workflow.store.authorTask(jobId);
  if (!author) {
    return `Job ${jobId} has no artifact yet: its researcher task ${task.task_id} is ${task.status}. Wait for its author task.`;
  }
  const artifact = workflow.store.artifact(jobId);
  if (workflow.stageFor(job).ending === "choice") {
    const checked = await checkSelection(workflow, { job, artifact, option, personMessages });
    if ("refusal" in checked) return checked.refusal;
    workflow.store.updateJobSelection(jobId, checked.selection);
  } else {
    const pending = await acceptancePending(workflow, artifact, personMessages);
    if (pending) return pending;
  }
  return whatIsNext(workflow, job, await completeJob(workflow, author, result));
}

async function cancel(workflow: WorkflowRuntime, jobId: string, reason: string): Promise<string> {
  if (!workflow.store.job(jobId)) return `Job ${jobId} does not exist.`;
  const task = workflow.store.authorOrResearcherTaskOf(jobId);
  if (isTaskFinished(task.status)) {
    return `Job ${jobId} is already over: its ${task.role} task is ${task.status}.`;
  }
  await cancelTask(workflow, task, reason);
  return `Cancelled job ${jobId}.`;
}

/** The refusal to complete a job whose host has not accepted its artifact, asking the host. */
async function acceptancePending(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow | null,
  personMessages: string[],
): Promise<string | null> {
  if (!artifact || artifact.status === "accepted") return null;
  const kind = workflow.artifact(artifact.kind);
  if (!kind.accepted) return humansAcceptancePending(workflow, artifact, personMessages);
  const accepted = await kind.accepted(artifact.ref).catch((error: unknown) => {
    workflow.log(
      null,
      `acceptance check of job ${artifact.job_id} failed: ${String(error).slice(0, 200)}`,
    );
    return false;
  });
  if (!accepted) {
    const note = kind.readyInstructions();
    return `The artifact of job ${artifact.job_id} is ${artifact.status}, and the host has not accepted it. ${note}`.trim();
  }
  workflow.store.advanceArtifact(artifact.job_id, ["drafted", "ready"], "accepted");
  workflow.log(null, `the host accepted the artifact of job ${artifact.job_id}. recorded.`);
  return null;
}

/** The refusal to complete a job whose artifact only the humans accept, and they have not. */
async function humansAcceptancePending(
  workflow: WorkflowRuntime,
  artifact: ArtifactRow,
  personMessages: string[],
): Promise<string | null> {
  const name = `the ${artifact.kind} of job ${artifact.job_id}`;
  if (personMessages.length === 0) {
    return `Only the humans accept ${name}, and no person wrote in this turn. Wait for their reply.`;
  }
  const accepted = await humansAccepted(workflow, artifact.external_url, personMessages);
  if (!accepted) {
    return `The person's message does not clearly accept ${name}. Ask them whether it is accepted. Send a change they asked for to the author task with prompt_task.`;
  }
  return null;
}

type SelectionInput = {
  job: JobRow;
  artifact: ArtifactRow | null;
  option: string | undefined;
  personMessages: string[];
};

/** The selection on a stage with a choice ending, or the refusal to complete. */
async function checkSelection(
  workflow: WorkflowRuntime,
  { job, artifact, option, personMessages }: SelectionInput,
): Promise<{ selection: string } | { refusal: string }> {
  const stage = `Stage ${job.stage} ends on a choice`;
  if (option === undefined) {
    return {
      refusal: `${stage}. Pass the option a person selected, as the page of job ${job.job_id} lists it.`,
    };
  }
  if (personMessages.length === 0) {
    return {
      refusal: `${stage}, and no person wrote in this turn. Wait for a person to select an option.`,
    };
  }
  if (artifact?.ref.kind !== "page") {
    return { refusal: `Job ${job.job_id} has no page yet. Wait for its author task.` };
  }
  const docs = await workflow.docs();
  if (!docs) return { refusal: `${stage}, and this workflow has no document host to read.` };
  const pageText = await docs.readPageContent(artifact.ref.page_id).catch((error: unknown) => {
    workflow.log(null, `page read of job ${job.job_id} failed: ${String(error).slice(0, 200)}`);
    return null;
  });
  if (pageText === null) {
    return { refusal: `The page of job ${job.job_id} could not be read. Try again later.` };
  }
  const options = parseDocumentOptions(pageText);
  if (!options.includes(option)) {
    const listed = options.length
      ? `It lists: ${options.map((listedOption) => `"${listedOption}"`).join(", ")}.`
      : "It lists none. Ask the author task with prompt_task to list them.";
    return {
      refusal: `The page of job ${job.job_id} lists no option "${option}" under its options heading. ${listed}`,
    };
  }
  const selected = await humansSelected(workflow, { option, options, messages: personMessages });
  if (!selected) {
    return {
      refusal: `The person's message does not clearly select "${option}". Ask them which option they choose.`,
    };
  }
  return { selection: option };
}

/** What the plan suggests after this job. A job on an issue leaves its stage open. */
function whatIsNext(workflow: WorkflowRuntime, job: JobRow, outcome: CompleteOutcome): string {
  const done = `Job ${job.job_id} done.`;
  if (job.issue_id || outcome.running > 0) {
    return `${done} Stage ${job.stage} stays open with ${outcome.running} running and ${outcome.slots} free slots. Start the next ready issues, or move on when the tracker shows none left.`;
  }
  const { stages } = workflow.state;
  const index = stages.indexOf(job.stage);
  if (index === -1) {
    return `${done} Stage ${job.stage} is not in the plan, so the plan names no next stage. Call set_plan when the route changed.`;
  }
  const next = stages[index + 1];
  if (next)
    return `${done} Next stage: ${next}. Call start_job with stage ${next} and a brief for it.`;
  return `${done} That was the last planned stage. Call finish_workflow when the work is complete, or start_job for more.`;
}
