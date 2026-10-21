import { stageLines } from "../../agent/prompt/stage-lines";
import { firingMessage, type FiringEvent } from "../../agent/transcript/envelope";
import { storedWorkflowDefinition, type WorkflowTrigger } from "../../config/workflow-definition";
import { screenText, type Screened } from "../../decisions/screen";
import { newWorkflowId } from "../../ids";
import { firingKey } from "../../triggers/firing-key";
import { triggeredWorkflowName } from "../../triggers/start-line";
import type { ConversationFiring, FiringAnswer, FiringCause } from "../../triggers/types";
import { armIdle, changeWorkflowStatus, writeRouterWorkflowStatus } from "../lifecycle";
import type { WorkflowRow } from "../store/workflow-row";
import type { WorkflowRuntime } from "../types";

/** A firing the firing queue's consumer handed to a conversation, with that conversation's id. */
export type FiringDelivery = { conversationId: string; firing: ConversationFiring };

/**
 * Take a firing. A vendor event's payload passes the screen first. Then one synchronous block
 * records the firing key as seen and either creates the running workflow or prompts the active
 * workflow of the firing's definition, and queues that agent message, which `tellAgent` does
 * before its first await.
 * A firing seen before gets the duplicate answer. An active workflow that is ending, or that runs
 * another definition, refuses the firing, so the attempt fails and the consumer tries again.
 */
export async function fireWorkflow(
  workflow: WorkflowRuntime,
  { conversationId, firing: delivered }: FiringDelivery,
): Promise<FiringAnswer> {
  const { firing } = delivered;
  const key = firingKey(firing);
  if (workflow.store.eventSeen(key)) return { kind: "duplicate" };
  const event = await screenedFiringEvent(workflow, firing.cause);
  if (workflow.store.eventSeen(key)) return { kind: "duplicate" };
  const active = workflow.store.activeWorkflow();
  if (active?.status === "ending") return { kind: "ending", workflow_id: active.workflow_id };
  if (active && active.definition !== firing.definition) {
    return { kind: "active_workflow", workflow_id: active.workflow_id };
  }
  if (active) return promptActiveWorkflow(workflow, { delivered, event, active });
  return startFiredWorkflow(workflow, { conversationId, delivered, event });
}

/** A firing with its vendor event as the screen left it. */
type ScreenedFiring = { delivered: ConversationFiring; event: FiringEvent | null };

/** Open the conversation on the firing's origin when no event opened it, and start the workflow. */
async function startFiredWorkflow(
  workflow: WorkflowRuntime,
  { conversationId, delivered, event }: ScreenedFiring & { conversationId: string },
): Promise<FiringAnswer> {
  const { firing, trigger, origin } = delivered;
  const key = firingKey(firing);
  const definition = storedWorkflowDefinition(workflow.workflowDefinitions(), firing.definition);
  const name = triggeredWorkflowName(definition.name);
  const firedBy = firedByText(trigger, definition.name);
  const workflowId = newWorkflowId();
  workflow.store.markEventSeen(key);
  if (!workflow.store.conversation()) {
    workflow.store.openConversation({
      conversation_id: conversationId,
      origin,
    });
  }
  workflow.store.createWorkflow({
    workflow_id: workflowId,
    definition: definition.name,
    name,
    reason: `Fired by ${firedBy}`,
    repo: origin.source === "code" ? origin.repo : null,
    request_text: trigger.prompt,
    request_links: [],
    subject: null,
  });
  await workflow.tellAgent(
    firingMessage({
      first: true,
      trigger: firedBy,
      prompt: trigger.prompt,
      event,
      notes: [
        `Workflow "${name}" started from workflow definition ${definition.name}.`,
        `Call set_plan with definition ${definition.name} and the stages to run.`,
      ],
      stages: stageLines(workflow.config(), definition),
    }),
    "message",
  );
  workflow.log(null, `workflow fired: definition=${definition.name} firing=${key}`);
  await writeRouterWorkflowStatus(workflow);
  await armIdle(workflow);
  return { kind: "started", workflow_id: workflowId };
}

/**
 * Send the firing's prompt to the active workflow of its definition, once per firing key, and wake
 * it when it waits for input.
 */
async function promptActiveWorkflow(
  workflow: WorkflowRuntime,
  { delivered, event, active }: ScreenedFiring & { active: WorkflowRow },
): Promise<FiringAnswer> {
  const { firing, trigger } = delivered;
  const key = firingKey(firing);
  workflow.store.markEventSeen(key);
  await workflow.tellAgent(
    firingMessage({
      first: false,
      trigger: firedByText(trigger, active.definition),
      prompt: trigger.prompt,
      event,
      notes: [`Workflow "${active.name}" runs this definition already, so this prompt is for it.`],
      stages: [],
    }),
    "message",
  );
  workflow.log(null, `firing prompted the active workflow: firing=${key}`);
  if (active.status === "waiting_input") await changeWorkflowStatus(workflow, "running");
  await armIdle(workflow);
  return { kind: "prompted", workflow_id: active.workflow_id };
}

/** How the agent and the workflow's reason name a trigger: by its schedule or by its event. */
function firedByText(trigger: WorkflowTrigger, definition: string): string {
  const what =
    "schedule" in trigger ? `the schedule ${trigger.schedule}` : `the event ${trigger.event}`;
  return `${what} of workflow definition ${definition}`;
}

/**
 * The vendor event of a firing, with the payload the screen admitted, or the fixed line that
 * stands in for one it did not. Null for a schedule.
 */
async function screenedFiringEvent(
  workflow: WorkflowRuntime,
  cause: FiringCause,
): Promise<FiringEvent | null> {
  switch (cause.kind) {
    case "schedule":
      return null;
    case "vendor_event": {
      const screened = await screenText(workflow, {
        source: `the payload of ${cause.event}`,
        text: cause.payload,
      });
      const payload = screened === "admitted" ? cause.payload : unadmittedPayloadText(screened);
      return { name: cause.event, payload };
    }
    default: {
      const unreachable: never = cause;
      throw new Error(`unhandled firing cause ${String(unreachable)}`);
    }
  }
}

/** What the agent reads in place of a payload the screen did not admit. It never holds the payload. */
function unadmittedPayloadText(screened: Exclude<Screened, "admitted">): string {
  switch (screened) {
    case "quarantined":
      return "[quarantined payload] The screen found text in the payload that looks written to steer an AI agent, so it was not given to you. Work from the prompt alone.";
    case "unchecked":
    case "too_large":
      return "[unchecked payload] The screen could not check the payload, so it was not given to you. Work from the prompt alone.";
    default: {
      const unreachable: never = screened;
      throw new Error(`unhandled screen outcome ${String(unreachable)}`);
    }
  }
}
