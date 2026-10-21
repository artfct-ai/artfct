import type { PromptKind } from "../src/workflow/store/schema";
import type { WorkflowStore } from "../src/workflow/store/tasks";

/** The kinds of queued prompts that the specs tell apart. */
export const SPEC_QUEUED_PROMPTS = ["Instruction", "OtherPrompt"] as const;

/** The kind of a queued prompt as the specs name it. */
export type SpecQueuedPrompt = (typeof SPEC_QUEUED_PROMPTS)[number];

/** The queued prompts that wait for a next turn. A taken or steered instruction stays queued until its turn ends. */
export function waitingPromptsInQueue(store: WorkflowStore) {
  const steered = new Set(store.steers().map((steer) => steer.prompt_id));
  return store.queue().filter((row) => !steered.has(row.id));
}

/** The spec kind of a queued prompt row. */
export function specQueuedPromptOf(row: { kind: PromptKind }): SpecQueuedPrompt {
  switch (row.kind) {
    case "instruction":
      return "Instruction";
    case "workflow":
      return "OtherPrompt";
    default: {
      const unhandled: never = row.kind;
      throw new Error(`unknown prompt kind ${String(unhandled)}`);
    }
  }
}

/** The prompts that wait for the task's next turn, and whether its running turn holds an instruction. */
export function specPromptsOf(
  store: WorkflowStore,
  taskId: string,
): { waiting: SpecQueuedPrompt[]; holdsInstruction: boolean } {
  const queue = store.queue().filter((row) => row.task_id === taskId);
  const waiting = waitingPromptsInQueue(store).filter((row) => row.task_id === taskId);
  return {
    waiting: waiting.map(specQueuedPromptOf),
    holdsInstruction: waiting.length < queue.length,
  };
}
