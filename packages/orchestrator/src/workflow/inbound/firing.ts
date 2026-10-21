import type { ReplyTarget } from "@artfct-ai/contracts/inbound";
import { stageLines } from "../../agent/prompt/stage-lines";
import { firingMessage } from "../../agent/transcript/envelope";
import { storedWorkflowDefinition } from "../../config/workflow-definition";
import { newWorkflowId } from "../../ids";
import { firingKey } from "../../triggers/firing-key";
import { triggeredWorkflowName } from "../../triggers/start-line";
import type { ConversationFiring, FiringAnswer } from "../../triggers/types";
import { armIdle, writeRouterWorkflowStatus } from "../lifecycle";
import type { WorkflowRuntime } from "../types";

/** A firing the firing queue's consumer handed to a conversation, with that conversation's id. */
export type FiringDelivery = { conversationId: string; firing: ConversationFiring };

/**
 * Start the workflow a trigger fired, with the trigger's definition. One synchronous block records
 * the firing key as seen, opens the conversation on the start line's thread when no event opened
 * it, creates the running workflow, and queues the agent's first message with the trigger's prompt,
 * which `tellAgent` does before its first await.
 * A firing seen before gets the duplicate answer. A conversation with an active workflow, such as
 * one that is still ending, refuses the firing, so the attempt fails and the consumer tries again.
 */
export async function fireWorkflow(
  workflow: WorkflowRuntime,
  { conversationId, firing: { firing, trigger, thread } }: FiringDelivery,
): Promise<FiringAnswer> {
  const key = firingKey(firing);
  if (workflow.store.eventSeen(key)) return { kind: "duplicate" };
  const active = workflow.store.activeWorkflow();
  if (active) return { kind: "active_workflow", workflow_id: active.workflow_id };
  const definition = storedWorkflowDefinition(workflow.workflowDefinitions(), firing.definition);
  const origin: ReplyTarget = { source: "chat", channel: trigger.channel, thread };
  const name = triggeredWorkflowName(definition.name);
  const firedBy = `the schedule ${trigger.schedule} of workflow definition ${definition.name}`;
  const workflowId = newWorkflowId();
  workflow.store.markEventSeen(key);
  if (!workflow.store.conversation()) {
    workflow.store.openConversation({
      conversation_id: conversationId,
      origin,
      request_title: name,
      request_text: trigger.prompt,
      request_links: [],
    });
  }
  workflow.store.createWorkflow({
    workflow_id: workflowId,
    definition: definition.name,
    name,
    reason: `Fired by ${firedBy}`,
    repo: null,
    subject: null,
  });
  await workflow.tellAgent(
    firingMessage({
      trigger: firedBy,
      prompt: trigger.prompt,
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
