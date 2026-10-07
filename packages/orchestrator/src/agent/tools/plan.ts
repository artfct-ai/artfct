import { tool } from "ai";
import { z } from "zod";
import { changeWorkflowStatus, completeWorkflow, failWorkflow } from "../../workflow/lifecycle";
import { isWorkflowFinished } from "../../workflow/store/state";
import type { WorkflowRuntime } from "../../workflow/types";
import { planPages } from "./page-plan";

/** The tool that ends the workflow as done. */
export const FINISH_WORKFLOW = "finish_workflow";
/** The tool that ends the workflow as failed. */
export const FAIL_WORKFLOW = "fail_workflow";

/** How the agent plans the route and ends the workflow. Kept next to the tools that do it. */
export const PLAN_RULES = `## Workflow Planning Protocol

### Stage Formulation & Planning
* **Map** the fewest stages from the Stages list, in its order, that take the request from its input artifacts to the deliverable it asks for.
* **Start** the plan at the stage after the last stage that produces the request's artifact. A request that links a page or a pull request, or names a tracker issue, already has that artifact. Pass the link to \`start_job\` as \`artifact\`, or the issue identifier as \`issue\`, on the first job. Plan an earlier stage only if the request asks for it by name.
* **Default** to the single stage that produces the deliverable unless the request asks for more stages.
* **Call** \`set_plan(name, stages, repo)\` when a message asks for work, and again whenever scope or requirements change.

### Plan Naming Standards
* **Assign** a concise, deliverable-focused title describing the end-state product.
* **Persist** the existing workflow name across subsequent \`set_plan\` calls unless the underlying deliverable fundamentally changes.

### Repository Binding
* **Query** accessible repositories using \`list_repositories\`.
* **Match** target repository (\`owner/name\`) against issue/project metadata, labels, or prompt URLs.
* **Bind** the resolved repository to \`set_plan\` for all stages, including stages that do not write code.
* **Call** \`ask\` and halt execution if a required repository cannot be identified unambiguously.

### Workflow Termination & Failure Handling
* **SUCCESSFUL_COMPLETION**: Call \`finish_workflow("<result>")\` when deliverables are satisfied and zero jobs are active.
* **RECOVERABLE_FAILURE**: Call \`start_job\` to re-dispatch a failed job.
* **FATAL_FAILURE**: Call \`fail_workflow("<reason>")\` when a job cannot succeed.

### Invariants & Exclusions
* **Prohibit Step-Based Plan Names**: Never name plans after transient stages or current operational steps.
* **Prohibit Repository Guessing**: Never guess repository identifiers; halt execution and prompt via \`ask\`.
* **Prohibit Premature Workflow Completion**: Never call \`finish_workflow\` while active jobs remain running.`;

/** Tools that shape the workflow: the plan and its concurrency, or the end of the workflow. */
export function planTools(workflow: WorkflowRuntime) {
  const pageParentHint = workflow.artifact("page").pageParentHint ?? "";
  return {
    set_plan: tool({
      description:
        "Set the stages you intend to run, in order, the repository, the page parent, the root page, and how many jobs may run at once. Stage names must come from the config. The plan is a guide you can change at any time: call it again when the request changes or a human asks for a different route.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            "a short display name for the whole workflow, a few words on what it delivers. Every reader shows it.",
          ),
        stages: z.array(z.string()).min(1),
        repo: z
          .string()
          .nullable()
          .describe(
            "owner/name. Set it whenever the context names one, in every stage, so the harness can read the source. Null only when nothing names one and no stage needs one.",
          ),
        page_parent: z
          .string()
          .nullable()
          .describe(
            `where the document host puts this workflow's pages: ${pageParentHint} Set it whenever the context names one.`,
          ),
        root_page: z
          .string()
          .nullable()
          .optional()
          .describe(
            "the link of an existing page that is the root page, the page people read first. Pass it only when set_plan asks for it. Null otherwise.",
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
        const refusal = endedWorkflowRefusal(workflow) ?? unfinishedJobsRefusal(workflow);
        if (refusal) return refusal;
        await completeWorkflow(workflow, result);
        return "Workflow finished.";
      },
    }),
    [FAIL_WORKFLOW]: tool({
      description:
        "Stop the workflow as failed. Cancels every task, tears down the sandboxes, and tells every channel the reason as the last message of the turn.",
      inputSchema: z.object({ reason: z.string() }),
      execute: async ({ reason }) => {
        const ended = endedWorkflowRefusal(workflow);
        if (ended) return ended;
        await failWorkflow(workflow, reason);
        return "Workflow failed.";
      },
    }),
  };
}

/** The refusal of every tool that would change a finished workflow. Null while it runs. */
export function endedWorkflowRefusal(workflow: WorkflowRuntime): string | null {
  const { status } = workflow.state;
  if (!isWorkflowFinished(status)) return null;
  return `The workflow is ${status}. A finished workflow stays finished.`;
}

/** The refusal to finish the workflow while a job has an unfinished author or researcher task. */
function unfinishedJobsRefusal(workflow: WorkflowRuntime): string | null {
  const unfinished = workflow.store.activeAuthorAndResearcherTasks();
  if (unfinished.length === 0) return null;
  const jobs = unfinished.map((task) => `Job ${task.job_id} is ${task.status}.`).join(" ");
  return `${jobs} complete_job or cancel_job ends a job. Finish the workflow once no job runs.`;
}

type PlanInput = {
  name: string;
  stages: string[];
  repo: string | null;
  page_parent: string | null;
  root_page?: string | null;
  reason: string;
  concurrency?: number;
};

async function setPlan(workflow: WorkflowRuntime, input: PlanInput): Promise<string> {
  const { stages } = workflow.workflowDefinition();
  const known = new Set(stages.map((stage) => stage.name));
  const unknown = input.stages.filter((name) => !known.has(name));
  if (unknown.length) return `Unknown stages: ${unknown.join(", ")}. Use names from the config.`;
  const needsRepo = stages.some((stage) => input.stages.includes(stage.name) && stage.branch);
  if (needsRepo && !input.repo) {
    return "A planned stage needs a repository and none was given. Find it in the request, the tracker issue and its project, or list_repositories, then call set_plan again. Ask only when nothing points to one.";
  }
  const unreachable = input.repo ? await unreachableRepo(workflow, input.repo) : null;
  if (unreachable) return unreachable;
  const ended = endedWorkflowRefusal(workflow);
  if (ended) return ended;
  const pages = await planPages(workflow, {
    name: input.name,
    stages: stages.filter((stage) => input.stages.includes(stage.name)),
    page_parent: input.page_parent,
    root_page: input.root_page ?? null,
  });
  if ("refusal" in pages) return pages.refusal;
  const cap = workflow.config().orchestrator.sandbox.max_concurrency;
  const concurrency = Math.min(input.concurrency ?? cap, cap);
  const first = workflow.state.stages.length === 0;
  workflow.patchState({
    name: input.name,
    stages: input.stages,
    concurrency,
    repo: input.repo ? { full: input.repo } : null,
    page_parent: pages.page_parent,
    root_page: pages.root_page,
    reason: input.reason,
  });
  await changeWorkflowStatus(workflow, "running");
  workflow.log(
    null,
    `plan: name=${input.name} stages=${input.stages.join(",")} repo=${input.repo ?? "-"} concurrency=${concurrency} (${input.reason})`,
  );
  const origin = workflow.state.origin;
  if (first && origin?.source === "tracker") await workflow.notifier.moveIssue(origin, "started");
  return `Plan set: ${input.stages.join(" -> ")}, up to ${concurrency} jobs at once.${pages.note} Call start_job with stage ${input.stages[0]} and a brief for it.`;
}

/**
 * The refusal for a repository the code host does not grant access to. Null when it is
 * reachable, or when no code host is configured and nothing can be checked.
 */
async function unreachableRepo(workflow: WorkflowRuntime, repo: string): Promise<string | null> {
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
