import { tool } from "ai";
import { z } from "zod";
import { pauseTask, resumeTask } from "../../workflow/inbound/controls";
import { cancelTask } from "../../workflow/lifecycle";
import { promptTask } from "../../workflow/task/harness/prompt-queue";
import { isTaskFinished } from "../../workflow/store/state";
import type { TaskRow } from "../../workflow/store/tasks";
import { reviewerEntryOf } from "../../workflow/refiner/stage-refiner";
import type { WorkflowRuntime } from "../../workflow/types";

const taskIdField = z.string().describe("the task id, for example wf_abc.2");

/** How the agent talks to a harness. Kept next to the tools that carry the words. */
export const HARNESS_RULES = `## Harness Interaction Protocol

### Inbound Message Routing
* **Evaluate** messages received during task execution for intent (harness guidance vs. user inquiry).
* **Call** \`prompt_task(task_id, guidance)\` to forward operational instructions to the harness.
* **Resolve** user inquiries using lookup tools, returning the response in the final closing text.
* **Call** \`ask\` immediately if the targeted task cannot be determined unambiguously.

### Pull Request Comment Triaging
* **Ignore** pull request comments flagged by system notes as already dispatched to the author.
* **Triage** unrouted incoming pull request comments within the current turn:
  * Execute tracker and backlog updates directly.
  * Forward author-actionable requirements using \`prompt_task(task_id, feedback)\`.

### Invariants & Exclusions
* **Prohibit Premature Review Resolution**: Never treat pull request approvals as task completion. A merged pull request is the sole source of truth.
* **Prohibit Duplicate CI Prompts**: Never dispatch guidance for CI breaks or merge conflicts already handled by system automation.
* **Prohibit Unactionable Harness Relays**: Never call \`prompt_task\` if incoming pull request comments contain no instructions relevant to the task harness.`;

/** The tool that sends a person's words to a running task. The board is the reply. */
export const PROMPT_TASK = "prompt_task";

/** Tools that drive one running task's harness. Every one names the task. */
export function taskTools(workflow: WorkflowRuntime) {
  return {
    [PROMPT_TASK]: tool({
      description:
        "Send a message to the harness working on a task. It is queued until the harness finishes its current turn. Wakes a sleeping sandbox.",
      inputSchema: z.object({ task_id: taskIdField, text: z.string().min(1) }),
      execute: ({ task_id, text }) =>
        withActiveTask(workflow, task_id, async (task) => {
          await promptTask(workflow, task, text);
          return `Queued for ${task.task_id}.`;
        }),
    }),
    pause_task: tool({
      description: "Stop the harness of a task after its current turn and hold queued prompts.",
      inputSchema: z.object({ task_id: taskIdField }),
      execute: ({ task_id }) =>
        withActiveTask(workflow, task_id, async (task) => {
          await pauseTask(workflow, task, workflow.transcript.answering());
          return `Paused ${task.task_id}.`;
        }),
    }),
    resume_task: tool({
      description: "Resume a paused task, with an optional message for the harness.",
      inputSchema: z.object({ task_id: taskIdField, text: z.string().optional() }),
      execute: ({ task_id, text }) =>
        withActiveTask(workflow, task_id, async (task) => {
          await resumeTask(workflow, task, {
            text: text ?? "",
            answering: workflow.transcript.answering(),
          });
          return `Resumed ${task.task_id}.`;
        }),
    }),
    cancel_task: tool({
      description:
        "Cancel one refiner run and destroy its sandbox: a refiner that hangs or that a person wants stopped. A cancelled reviewer leaves its entry open on the artifact. A cancelled polisher sends the artifact to the humans, because it stopped partway through changing it. An author task is refused: cancel_job stops its job.",
      inputSchema: z.object({ task_id: taskIdField, reason: z.string() }),
      execute: ({ task_id, reason }) => cancelByAgent(workflow, task_id, reason),
    }),
  };
}

async function cancelByAgent(
  workflow: WorkflowRuntime,
  taskId: string,
  reason: string,
): Promise<string> {
  const task = workflow.store.task(taskId);
  if (!task) return `Task ${taskId} does not exist.`;
  if (task.role === "author" || task.role === "researcher") {
    return `Task ${task.task_id} is the ${task.role} of job ${task.job_id}. cancel_job stops the job.`;
  }
  if (isTaskFinished(task.status)) return `Task ${task.task_id} is ${task.status}.`;
  await cancelTask(workflow, task, reason);
  if (task.role === "polisher") {
    return `Cancelled polisher ${task.task_id}. It was changing the artifact of job ${task.job_id}, so that artifact goes to the humans with the branch as the polisher left it.`;
  }
  const handOn =
    reviewerEntryOf(workflow, task)?.mode === "judge"
      ? "rule_on_review with a person's ruling to go on without it"
      : "finish_review to hand the artifact on without it";
  return `Cancelled reviewer ${task.task_id}. Its entry stays open on job ${task.job_id}. Call request_review to run it again, or ${handOn}.`;
}

async function withActiveTask(
  workflow: WorkflowRuntime,
  taskId: string,
  run: (task: TaskRow) => Promise<string>,
): Promise<string> {
  const task = workflow.store.task(taskId);
  if (!task) return `Task ${taskId} does not exist.`;
  if (task.role !== "author") {
    const stopper =
      task.role === "researcher" ? "cancel_job stops its job" : "cancel_task stops it";
    return `Task ${task.task_id} is a ${task.role}. The system runs it end to end. You cannot prompt, pause, or resume one. ${stopper}.`;
  }
  if (isTaskFinished(task.status)) return `Task ${task.task_id} is ${task.status}.`;
  return run(task);
}
