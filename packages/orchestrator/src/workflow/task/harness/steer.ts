import type { WorkflowRuntime } from "../../types";
import type { TaskRow } from "../../store/tasks";
import { sendRequest } from "./bridge";

/**
 * Steer each waiting person instruction into the running turn. A harness that cannot steer, or a
 * task without an open bridge, keeps them queued for the next prompt.
 */
export function steerWaitingInstructions(workflow: WorkflowRuntime, task: TaskRow): void {
  const sandbox = workflow.store.requireSandbox(task.task_id);
  const steering = workflow.harness(sandbox.harness).steering;
  const sessionId = sandbox.session_id;
  if (!steering || !sessionId || workflow.connections(task.task_id).length === 0) return;
  for (const instruction of workflow.store.waitingInstructions(task.task_id)) {
    const { method, params } = steering.request(sessionId, instruction.text);
    const rpcId = sendRequest(workflow, task, method, params, "steer");
    workflow.store.steerPrompt(instruction.id, rpcId);
    workflow.log(task.task_id, `steered instruction ${instruction.id} into the running turn`);
  }
}

/**
 * The harness answered steer `rpcId`. A taken instruction leaves the queue when its turn ends on
 * its own. One the turn did not take goes as the next prompt.
 */
export function onSteerAnswer(
  workflow: WorkflowRuntime,
  task: TaskRow,
  rpcId: number,
  result: unknown,
): void {
  const sandbox = workflow.store.requireSandbox(task.task_id);
  if (workflow.harness(sandbox.harness).steering?.taken(result)) {
    workflow.store.takeSteer(rpcId);
    workflow.log(task.task_id, `the running turn took steer ${rpcId}`);
    return;
  }
  workflow.log(task.task_id, `the turn did not take steer ${rpcId}. it goes as the next prompt.`);
}
