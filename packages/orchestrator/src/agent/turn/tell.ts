import type { WroteFrom } from "../transcript/transcript";
import type { Wake, WorkflowRuntime } from "../../workflow/types";

/**
 * Queue text for the agent and run its turn here, in the invocation that queued it. The zero
 * delay `runAgent` alarm is the backup alarm, cancelled once the turn lane returns.
 */
export async function tellAgent(
  workflow: WorkflowRuntime,
  text: string,
  wake: Wake,
  from?: WroteFrom,
): Promise<void> {
  workflow.transcript.enqueue(text, wake, from);
  if (wake === "none") return;
  workflow.log(null, `agent wake: ${wake}`);
  const backup = await workflow.scheduleAlarm(0, "runAgent", {});
  workflow.agentTurns
    .run(() => workflow.agentTurn())
    .then(() => workflow.cancelAlarm(backup))
    .catch((error: unknown) => {
      console.warn(
        `[${workflow.store.requireWorkflowRow().workflow_id}] agent turn failed: ${String(error).slice(0, 300)}`,
      );
    });
}

/** The `runAgent` alarm: one agent turn, only when the turn lane is idle. */
export function runAgent(workflow: WorkflowRuntime): Promise<void> {
  return workflow.agentTurns.runIfIdle(() => workflow.agentTurn());
}
