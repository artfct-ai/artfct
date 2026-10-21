import type { IdentityQuery, VendorEvent, VendorEventDelivery } from "@artfct-ai/contracts/types";
import { chat, codeHost } from "../clients";
import { registeredConfig } from "../config/register-config";
import { createDb } from "../db/client";
import { deleteFiringThreadsBefore } from "../db/firing-threads";
import type { Env } from "../env";
import { resolveActor } from "../router/identity";
import { fireMatchingTriggers } from "../router/vendor-event";
import { consumeFiring, type FiringConsumer } from "./consumer";
import { scheduledFirings } from "./schedule";
import type { TriggerFiring } from "./types";

/** How long the firing queue holds a message. A start line record is read only within it. */
const FIRING_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * The scheduled run of one minute. Queue a firing for each schedule trigger that matches the
 * scheduled minute, then delete the start line records the queue can no longer need.
 */
export async function runScheduledMinute(env: Env, scheduledTime: number): Promise<void> {
  const firings = scheduledFirings(registeredConfig().workflowDefinitions, scheduledTime);
  if (firings.length) await env.TRIGGER_FIRINGS.sendBatch(firings.map((body) => ({ body })));
  await deleteFiringThreadsBefore(createDb(env.DB), new Date(scheduledTime - FIRING_RETENTION_MS));
}

/** Queue a firing for each trigger the vendor event matches, for a causer who passes access. */
export function deliverVendorEvent(env: Env, event: VendorEvent): Promise<VendorEventDelivery> {
  const router = {
    definitions: registeredConfig().workflowDefinitions,
    resolveActor: (query: IdentityQuery) => resolveActor(env, query),
    sendFirings: async (firings: TriggerFiring[]) => {
      await env.TRIGGER_FIRINGS.sendBatch(firings.map((body) => ({ body })));
    },
  };
  return fireMatchingTriggers(router, event);
}

/** The firing queue's consumer. Each message is one attempt. */
export async function consumeFiringBatch(
  env: Env,
  batch: MessageBatch<TriggerFiring>,
): Promise<void> {
  const { config, workflowDefinitions } = registeredConfig();
  const consumer: FiringConsumer = {
    db: createDb(env.DB),
    chat: chat(env, config.adapters.chat.provider),
    code: codeHost(env, config.adapters.code.provider),
    definitions: workflowDefinitions,
    fire: (conversationId, firing) => {
      return env.Conversation.getByName(conversationId).fire(conversationId, firing);
    },
    sendAttempt: async (firing, delaySeconds) => {
      await env.TRIGGER_FIRINGS.send(firing, { delaySeconds });
    },
  };
  for (const message of batch.messages) await consumeFiringMessage(consumer, message);
}

/** The parts of a queue message the consumer uses. */
type FiringMessage = Pick<Message<TriggerFiring>, "body" | "ack" | "retry">;

/**
 * Take one attempt from the queue. Acknowledge the message once the attempt returns. When it
 * throws, as when the send of the next attempt fails, the queue delivers the message again.
 */
export async function consumeFiringMessage(
  consumer: FiringConsumer,
  message: FiringMessage,
): Promise<void> {
  try {
    await consumeFiring(consumer, message.body);
    message.ack();
  } catch (error) {
    console.error(`a firing attempt threw, so the queue delivers it again: ${String(error)}`);
    message.retry();
  }
}
