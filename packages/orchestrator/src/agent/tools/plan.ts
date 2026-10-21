import { tool } from "ai";
import { z } from "zod";
import { newWorkflowId } from "../../ids";
import {
  armIdle,
  changeWorkflowStatus,
  completeWorkflow,
  failWorkflow,
  workflowEnding,
  writeRouterWorkflowStatus,
} from "../../workflow/lifecycle";
import type { Subject } from "../../workflow/store/state";
import type { WorkflowRow } from "../../workflow/store/workflow-row";
import {
  originSubject,
  setWorkflowSubject,
  subjectOfRef,
  validatePlanKeepsSubject,
} from "../../workflow/subject";
import type { WorkflowRuntime } from "../../workflow/types";
import type { WorkflowDefinition } from "../../config/workflow-definition";
import { stageLines } from "../prompt/stage-lines";
import { planPages } from "./page-plan";

/** The tool that ends the workflow as done. */
export const FINISH_WORKFLOW = "finish_workflow";
/** The tool that ends the workflow as failed. */
export const FAIL_WORKFLOW = "fail_workflow";

/** How the agent plans the route and ends the workflow. Kept next to the tools that do it. */
export const PLAN_RULES = `## Workflow Planning Protocol

### Workflow Definition Selection
* **Pick** the one workflow definition from the Workflow definitions list whose description fits the request.
* **Call** \`set_plan(name, definition)\` without stages to start the workflow. Its answer lists the stages of that workflow definition.
* **Keep** the workflow definition the workflow started with. A later \`set_plan\` call names the same one.
* **Answer** a request for different work while a workflow runs: the work can start once the active workflow ends, or in a new thread now. A conversation runs one workflow at a time, so \`set_plan\` refuses another workflow definition.

### Stage Formulation & Planning
* **Map** the fewest stages from the Stages list, in its order, that take the request from its input artifacts to the deliverable it asks for.
* **Start** the plan at the stage after the last stage that produces the request's artifact. A request that links a page or a pull request, or names a tracker issue, already has that artifact. Pass the link to \`start_job\` as \`artifact\`, or the issue identifier as \`issue\`, on the first job. Plan an earlier stage only if the request asks for it by name.
* **Default** to the single stage that produces the deliverable unless the request asks for more stages.
* **Call** \`set_plan(name, definition, stages, repo)\` once the workflow started, and again whenever scope or requirements change.

### Plan Naming Standards
* **Assign** a concise, deliverable-focused title describing the end-state product.
* **Persist** the existing workflow name across subsequent \`set_plan\` calls unless the underlying deliverable fundamentally changes.

### Workflow Subject
* **Pass** \`subject\` with the link of the one tracker issue or tracker project the request is about, when the person names one and the workflow does not have a subject yet. A workflow that started in a tracker session has its issue as its subject.
* **Keep** the subject. It never changes. Work on another issue or project needs its own workflow.

### Repository Binding
* **Query** accessible repositories using \`list_repositories\`.
* **Match** target repository (\`owner/name\`) against issue/project metadata, labels, or prompt URLs.
* **Bind** the resolved repository to \`set_plan\` for all stages, including stages that do not write code.
* **Call** \`ask\` and halt execution if a required repository cannot be identified unambiguously.

### Invariants & Exclusions
* **Prohibit Step-Based Plan Names**: Never name plans after transient stages or current operational steps.
* **Prohibit Repository Guessing**: Never guess repository identifiers; halt execution and prompt via \`ask\`.`;

/** How the agent ends a workflow once it has started. */
export const END_RULES = `## Workflow Termination & Failure Handling
* **SUCCESSFUL_COMPLETION**: Call \`finish_workflow("<result>")\` when deliverables are satisfied and zero jobs are active.
* **RECOVERABLE_FAILURE**: Call \`start_job\` to re-dispatch a failed job.
* **FATAL_FAILURE**: Call \`fail_workflow("<reason>")\` when a job cannot succeed.

### Invariants & Exclusions
* **Prohibit Premature Workflow Completion**: Never call \`finish_workflow\` while active jobs remain running.`;

/** Tools that shape the workflow: the plan and its concurrency, or the end of the workflow. */
export function planTools(workflow: WorkflowRuntime) {
  const pageParentHint = workflow.artifact("page").pageParentHint ?? "";
  return {
    set_plan: tool({
      description:
        "Start the workflow from a workflow definition, then set the stages you intend to run, in order, the repository, the page parent, the root page, and how many jobs may run at once. The first call names the workflow definition and may leave out the stages. Its answer lists the stages of that workflow definition. Stage names must come from that list. The plan is a guide you can change at any time: call it again when the request changes or a human asks for a different route.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "a short display name for the whole workflow, a few words on what it delivers. Every reader shows it.",
          ),
        definition: z
          .string()
          .min(1)
          .describe(
            "the name of the workflow definition the workflow runs. The call that starts the workflow picks it, and every later call names the same one.",
          ),
        stages: z
          .array(z.string())
          .min(1)
          .optional()
          .describe(
            "the stages to run, in order. Leave them out only on the call that starts the workflow.",
          ),
        repo: z
          .string()
          .nullable()
          .optional()
          .describe(
            "owner/name. Set it whenever the context names one, on every call, so the harness can read the source. Null only when nothing names one and no stage needs one.",
          ),
        page_parent: z
          .string()
          .nullable()
          .optional()
          .describe(
            `where the document host puts this workflow's pages: ${pageParentHint} Set it whenever the context names one. Used only with stages.`,
          ),
        root_page: z
          .string()
          .nullable()
          .optional()
          .describe(
            "the link of an existing page that is the root page, the page people read first. Pass it only when set_plan asks for it. Null otherwise.",
          ),
        subject: z
          .string()
          .optional()
          .describe(
            "the link of the one tracker issue or tracker project the person named as what this workflow works on. Set once. It never changes. Leave it out when the workflow already has a subject or the person named neither.",
          ),
        reason: z.string().describe("one line on why this plan"),
        concurrency: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("jobs at once, capped by the config limit"),
      }),
      execute: (input) => setPlan(workflow, input),
    }),
    list_repositories: tool({
      description:
        "The repositories the code host grants the harness, as owner/name. Use it to match a name from the request, the issue, or its project. It is not for guessing: when nothing names a repository, ask.",
      inputSchema: z.object({}),
      execute: async () => listRepositories(workflow),
    }),
    [FINISH_WORKFLOW]: tool({
      description:
        "End the workflow as done, once the humans have what they asked for and no job is running. The result goes to every channel as the last message of the turn. Refused while a job runs.",
      inputSchema: z.object({ result: z.string() }),
      execute: async ({ result }) => {
        const error =
          validateWorkflowCreated(workflow) ??
          validateWorkflowRunning(workflow) ??
          validateJobsFinished(workflow);
        if (error) return error;
        await completeWorkflow(workflow, result);
        return "Workflow finished.";
      },
    }),
    [FAIL_WORKFLOW]: tool({
      description:
        "Stop the workflow as failed. Cancels every task, tears down the sandboxes, and tells every channel the reason as the last message of the turn.",
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        const ended = validateWorkflowCreated(workflow) ?? validateWorkflowRunning(workflow);
        if (ended) return ended;
        await failWorkflow(workflow, reason);
        return "Workflow failed.";
      },
    }),
  };
}

/**
 * Validate that the workflow still runs and is not ending, for every tool that would change it.
 * Null while it runs, and before a plan creates it.
 */
export function validateWorkflowRunning(workflow: WorkflowRuntime): string | null {
  if (workflowEnding(workflow)) return "The workflow is ending. A workflow that ends stays ended.";
  if (!workflow.store.workflowFinished()) return null;
  return `The workflow is ${workflow.store.workflowStatus()}. A finished workflow stays finished.`;
}

/** Validate that a plan created the workflow, before a tool that ends it. */
function validateWorkflowCreated(workflow: WorkflowRuntime): string | null {
  if (workflow.store.workflowRow()) return null;
  return "This conversation has no workflow. A set_plan call that names a workflow definition creates one.";
}

/** Validate that every author and researcher task is finished, before the workflow finishes. */
function validateJobsFinished(workflow: WorkflowRuntime): string | null {
  const unfinished = workflow.store.activeAuthorAndResearcherTasks();
  if (unfinished.length === 0) return null;
  const jobs = unfinished.map((task) => `Job ${task.job_id} is ${task.status}.`).join(" ");
  return `${jobs} complete_job or cancel_job ends a job. Finish the workflow once no job runs.`;
}

type PlanInput = {
  name: string;
  definition: string;
  stages?: string[];
  repo?: string | null;
  page_parent?: string | null;
  root_page?: string | null;
  subject?: string;
  reason: string;
  concurrency?: number;
};

/**
 * Validate that a plan names the workflow definition of the active workflow. Null when the
 * conversation has no active workflow and when the names match. A conversation runs one workflow
 * at a time, so a plan for other work waits for the end of the active one.
 */
function validateOneActiveWorkflow(active: WorkflowRow | null, named: string): string | null {
  if (active === null || active.definition === named) return null;
  return `Workflow "${active.name}" runs in this conversation from workflow definition ${active.definition}, and a conversation runs one workflow at a time. To change its plan, call set_plan with definition ${active.definition}. For other work, tell the person it can start once "${active.name}" ends, or in a new thread now.`;
}

/** Validate that every planned stage is a stage of the workflow definition. */
function validateStagesKnown(definition: WorkflowDefinition, planned: string[]): string | null {
  const known = new Set(definition.stages.map((stage) => stage.name));
  const unknown = planned.filter((name) => !known.has(name));
  if (unknown.length === 0) return null;
  return `Unknown stages: ${unknown.join(", ")}. Use names from workflow definition ${definition.name}.`;
}

async function setPlan(workflow: WorkflowRuntime, input: PlanInput): Promise<string> {
  if (workflowEnding(workflow)) {
    return "The workflow is ending. Once it ended, a set_plan call that names a workflow definition starts the next workflow.";
  }
  const definitions = workflow.workflowDefinitions();
  const definition = definitions.find((declared) => declared.name === input.definition);
  if (!definition) {
    const names = definitions.map((declared) => declared.name).join(", ");
    return `Unknown workflow definition ${input.definition}. The deployment holds: ${names}.`;
  }
  const active = workflow.store.activeWorkflow();
  const oneActive = validateOneActiveWorkflow(active, definition.name);
  if (oneActive) return oneActive;
  const subject = input.subject ? await resolvePlanSubject(workflow, input.subject) : null;
  if (typeof subject === "string") return subject;
  if (!input.stages) {
    if (active) {
      return `The workflow already started from workflow definition ${definition.name}. Call set_plan again with the stages.`;
    }
    const repoError = input.repo ? await validateRepoReachable(workflow, input.repo) : null;
    if (repoError) return repoError;
    await startWorkflow(workflow, definition, input);
    if (subject) await setWorkflowSubject(workflow, subject);
    return startedAnswer(workflow, definition);
  }
  return planStages(workflow, definition, { ...input, stages: input.stages }, subject);
}

/**
 * The subject a plan link names, for a workflow that has none yet. Null when the workflow has it
 * or will have it from its origin. A string says why the link cannot be the subject.
 */
async function resolvePlanSubject(
  workflow: WorkflowRuntime,
  link: string,
): Promise<Subject | null | string> {
  const target = await workflow.artifact("issues").detect(link);
  const ref = target?.ref;
  if (ref?.kind !== "issue" && ref?.kind !== "project") {
    return `The subject ${link} is not an issue or a project on the tracker. Pass the link of one, or leave subject out.`;
  }
  const kept = planSubject(workflow);
  const changed = kept ? await validatePlanKeepsSubject(workflow, kept, ref) : null;
  if (changed) return changed;
  return kept ? null : subjectOfRef(ref);
}

/** The subject of the active workflow, or the one its origin gives the workflow the plan creates. */
function planSubject(workflow: WorkflowRuntime): Subject | null {
  if (workflow.store.activeWorkflow()) return workflow.store.subject();
  return originSubject(workflow.store.requireConversation().origin);
}

/**
 * Create the running workflow from the plan that names its definition, with what the turn was
 * asked as its request and the subject its origin gives it, and start its idle clock. The tracker
 * issue moves to started.
 */
async function startWorkflow(
  workflow: WorkflowRuntime,
  definition: WorkflowDefinition,
  input: PlanInput,
): Promise<void> {
  const { origin } = workflow.store.requireConversation();
  const request = workflow.transcript.takenRequest();
  workflow.store.createWorkflow({
    workflow_id: newWorkflowId(),
    definition: definition.name,
    name: input.name,
    reason: input.reason,
    repo: input.repo ?? null,
    request_text: request.text,
    request_links: request.links,
    subject: originSubject(origin),
  });
  await writeRouterWorkflowStatus(workflow);
  await armIdle(workflow);
  workflow.log(null, `workflow started: definition=${definition.name} (${input.reason})`);
  if (origin?.source === "tracker") await workflow.notifier.moveIssue(origin, "started");
}

/** What the call that starts the workflow without stages answers: the stages to plan from. */
function startedAnswer(workflow: WorkflowRuntime, definition: WorkflowDefinition): string {
  return [
    `Workflow started from workflow definition ${definition.name}.`,
    "",
    ...stageLines(workflow.config(), definition),
    "",
    `Call set_plan again with definition ${definition.name} and the stages to run.`,
  ].join("\n");
}

async function planStages(
  workflow: WorkflowRuntime,
  definition: WorkflowDefinition,
  input: PlanInput & { stages: string[] },
  subject: Subject | null,
): Promise<string> {
  const unknown = validateStagesKnown(definition, input.stages);
  if (unknown) return unknown;
  const repo = input.repo ?? null;
  const planned = definition.stages.filter((stage) => input.stages.includes(stage.name));
  if (planned.some((stage) => stage.branch) && !repo) {
    return "A planned stage needs a repository and none was given. Find it in the request, the tracker issue and its project, or list_repositories, then call set_plan again. Ask only when nothing points to one.";
  }
  const repoError = repo ? await validateRepoReachable(workflow, repo) : null;
  if (repoError) return repoError;
  const pages = await planPages(workflow, {
    name: input.name,
    definition,
    stages: planned,
    page_parent: input.page_parent ?? null,
    root_page: input.root_page ?? null,
  });
  if ("error" in pages) return pages.error;
  if (!workflow.store.activeWorkflow()) await startWorkflow(workflow, definition, input);
  if (subject) await setWorkflowSubject(workflow, subject);
  const cap = workflow.config().orchestrator.sandbox.max_concurrency;
  const concurrency = Math.min(input.concurrency ?? cap, cap);
  workflow.store.updateWorkflow({ name: input.name, reason: input.reason, repo });
  workflow.store.writeStagePlan({
    stages: input.stages,
    job_slots: concurrency,
    page_parent: pages.page_parent,
    root_page: pages.root_page,
  });
  await changeWorkflowStatus(workflow, "running");
  workflow.log(
    null,
    `plan: definition=${definition.name} name=${input.name} stages=${input.stages.join(",")} repo=${repo ?? "-"} concurrency=${concurrency} (${input.reason})`,
  );
  return `Plan set: ${input.stages.join(" -> ")}, up to ${concurrency} jobs at once.${pages.note} Call start_job with stage ${input.stages[0]} and a brief for it.`;
}

/**
 * Validate that the code host grants access to the repository. Null when it is
 * reachable, or when a code host is not configured and the check cannot run.
 */
async function validateRepoReachable(
  workflow: WorkflowRuntime,
  repo: string,
): Promise<string | null> {
  const host = workflow.code();
  if (!host) return null;
  try {
    const reachable = await host.repositories();
    if (reachable.includes(repo)) return null;
    const listed = reachable.length ? reachable.join(", ") : "none";
    return `Repository ${repo} is not reachable. The code host grants access to: ${listed}. Use one of those when it matches the request, else ask for a repository link with ask and stop.`;
  } catch (error) {
    return `Could not check repository ${repo}: ${String(error).slice(0, 300)}. Call set_plan again.`;
  }
}

async function listRepositories(workflow: WorkflowRuntime): Promise<string> {
  const host = workflow.code();
  if (!host) return "No code host is configured.";
  try {
    const repos = await host.repositories();
    if (!repos.length) return "The code host grants access to no repository.";
    return [`Repositories (${repos.length}):`, ...repos.map((repo) => `- ${repo}`)].join("\n");
  } catch (error) {
    return `The code host lookup failed: ${String(error).slice(0, 300)}`;
  }
}
