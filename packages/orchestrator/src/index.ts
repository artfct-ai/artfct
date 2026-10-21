import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type {
  BindingRecord,
  Delivery,
  IdentityQuery,
  LinearInstallInput,
  LinearInstallLink,
  LinearInstallResult,
  OrchestratorRpc,
  WorkflowSummary,
} from "@artfct-ai/contracts/types";
import type { Actor } from "@artfct-ai/contracts/inbound";
import { WorkerEntrypoint } from "cloudflare:workers";
import { parseBridgePath } from "./workflow/task/harness/bridge-path";
import { listBindings } from "./db/bindings";
import { createDb } from "./db/client";
import { readLinearInstall } from "./db/linear-installs";
import { findWorkflow } from "./db/workflows";
import type { Env } from "./env";
import { completeLinearInstall, linearInstallUrl } from "./oauth/install";
import { deliver } from "./router/deliver";
import { resolveActor } from "./router/identity";
import { consumeFiringBatch, runScheduledMinute } from "./triggers/firing-queue";
import type { TriggerFiring } from "./triggers/types";
import { Conversation } from "./conversation";

export { Sandbox, Sandbox as SandboxLarge } from "./sandbox/durable-object";
export { Conversation };

/**
 * The orchestrator Worker. It owns the D1 database and every Conversation Durable Object.
 * Ingress reaches it only through this entrypoint: RPC for calls, `fetch` for the bridge
 * WebSocket upgrade.
 */
export default class Orchestrator extends WorkerEntrypoint<Env> implements OrchestratorRpc {
  deliver(event: InboundEvent): Promise<Delivery> {
    return deliver(this.env, event);
  }

  resolveActor(query: IdentityQuery): Promise<Actor | null> {
    return resolveActor(this.env, query);
  }

  async trackerWorkspace(): Promise<string | null> {
    const install = await readLinearInstall(createDb(this.env.DB));
    return install?.organization_id ?? null;
  }

  async status(workflowId: string): Promise<WorkflowSummary | null> {
    const workflow = await findWorkflow(createDb(this.env.DB), workflowId);
    if (!workflow) return null;
    return this.env.Conversation.getByName(workflow.conversation_id).status(workflowId);
  }

  debug(conversationId: string): Promise<unknown> {
    return this.env.Conversation.getByName(conversationId).debug();
  }

  bindings(): Promise<BindingRecord[]> {
    return listBindings(createDb(this.env.DB));
  }

  linearInstallUrl(input: { redirect_uri: string }): Promise<LinearInstallLink> {
    return linearInstallUrl(this.env, createDb(this.env.DB), input);
  }

  linearInstall(input: LinearInstallInput): Promise<LinearInstallResult> {
    return completeLinearInstall(this.env, createDb(this.env.DB), input);
  }

  /** The every-minute cron: queue the firings of the schedule triggers that match its minute. */
  override async scheduled(controller: ScheduledController): Promise<void> {
    await runScheduledMinute(this.env, controller.scheduledTime);
  }

  /** The firing queue's consumer: one attempt of a firing per message. */
  override async queue(batch: MessageBatch<TriggerFiring>): Promise<void> {
    await consumeFiringBatch(this.env, batch);
  }

  /**
   * The bridge WebSocket upgrade, forwarded by ingress. It goes to the conversation of the workflow
   * the dial names. A dial for a workflow that was never created gets 404 and opens none.
   */
  override async fetch(request: Request): Promise<Response> {
    const bridge = parseBridgePath(new URL(request.url).pathname);
    if (!bridge) return new Response("artfct-orchestrator", { status: 200 });
    const workflow = await findWorkflow(createDb(this.env.DB), bridge.workflowId);
    if (!workflow) return new Response("unknown workflow", { status: 404 });
    return this.env.Conversation.getByName(workflow.conversation_id).fetch(request);
  }
}
