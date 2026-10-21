import type { WorkflowTrigger } from "../config/workflow-definition";

/** What made a trigger fire: a schedule fires on one UTC minute, named by its ISO time. */
type FiringCause = { kind: "schedule"; minute: string };

/**
 * One trigger's occurrence, as the firing queue carries it. `position` is the trigger's place in
 * its definition's list. `attempt` counts the consumer's tries from 1.
 */
export type TriggerFiring = {
  cause: FiringCause;
  definition: string;
  position: number;
  attempt: number;
};

/** What the firing queue's consumer hands a conversation: the firing, its trigger, and its start line's thread. */
export type ConversationFiring = {
  firing: TriggerFiring;
  trigger: WorkflowTrigger;
  thread: string;
};

/**
 * What a conversation answers a firing: it started the workflow, it saw the firing before, or it
 * has an active workflow, so this attempt fails.
 */
export type FiringAnswer =
  | { kind: "started"; workflow_id: string }
  | { kind: "duplicate" }
  | { kind: "active_workflow"; workflow_id: string };
