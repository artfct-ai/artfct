import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import type { WorkflowTrigger } from "../config/workflow-definition";

/**
 * What made a trigger fire: a schedule fires on one UTC minute, named by its ISO time. A vendor
 * event fires with its delivery id, its name, and its payload rendered within the cap. The
 * conversation screens the payload before the agent reads it.
 */
export type FiringCause =
  | { kind: "schedule"; minute: string }
  | { kind: "vendor_event"; delivery_id: string; event: string; payload: string };

/**
 * Where a firing reports: under a start line in a channel, or on a pull request, whose
 * conversation with the firing's definition holds the workflow.
 */
export type FiringReport =
  | { kind: "channel"; channel: string }
  | { kind: "pull_request"; repo: string; number: number };

/**
 * One trigger's occurrence, as the firing queue carries it. `position` is the trigger's place in
 * its definition's list. `attempt` counts the consumer's tries from 1.
 */
export type TriggerFiring = {
  cause: FiringCause;
  reports: FiringReport;
  definition: string;
  position: number;
  attempt: number;
};

/** Where a firing's workflow replies: the thread of its start line, or its pull request. */
export type FiringOrigin = Extract<ReplyTarget, { source: "chat" | "code" }>;

/** What the firing queue's consumer hands a conversation: the firing, its trigger, and where it replies. */
export type ConversationFiring = {
  firing: TriggerFiring;
  trigger: WorkflowTrigger;
  origin: FiringOrigin;
};

/**
 * What a conversation answers a firing: it started the workflow, it sent the prompt to its active
 * workflow of the firing's definition, or it saw the firing before. An active workflow that is
 * ending, or that runs another definition, fails the attempt, so the consumer tries again.
 */
export type FiringAnswer =
  | { kind: "started"; workflow_id: string }
  | { kind: "prompted"; workflow_id: string }
  | { kind: "duplicate" }
  | { kind: "ending"; workflow_id: string }
  | { kind: "active_workflow"; workflow_id: string };
