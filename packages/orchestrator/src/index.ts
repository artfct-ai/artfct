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
import { Workflow } from "./workflow";

export { Sandbox, Sandbox as SandboxLarge } from "@cloudflare/sandbox";
export { Workflow };

/**
 * The orchestrator Worker. It owns the D1 database and every Workflow Durable Object.
 * Ingress reaches it only through this entrypoint: RPC for calls, `fetch` for the bridge
 * WebSocket upgrade.
 */
export default class Orchestrator extends WorkerEntrypoint<Env> implements OrchestratorRpc {
  deliver(event: InboundEvent): Promise<Delivery> {
    return deliver(this.env, event);
  }

  resolveActor(query: IdentityQuery): Promise<Actor | null> {
    return resolveActor(this.env, createDb(this.env.DB), query);
  }

  async trackerWorkspace(): Promise<string | null> {
    const install = await readLinearInstall(createDb(this.env.DB));
    return install?.organization_id ?? null;
  }

  status(workflowId: string): Promise<WorkflowSummary> {
    return this.env.Workflow.getByName(workflowId).status();
  }

  debug(workflowId: string): Promise<unknown> {
    return this.env.Workflow.getByName(workflowId).debug();
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

  /**
   * The bridge WebSocket upgrade, forwarded by ingress. It goes to the Durable Object that owns
   * the socket. A dial for a workflow that was never created gets 404 and creates none.
   */
  override async fetch(request: Request): Promise<Response> {
    const bridge = parseBridgePath(new URL(request.url).pathname);
    if (!bridge) return new Response("artfct-orchestrator", { status: 200 });
    const workflow = await findWorkflow(createDb(this.env.DB), bridge.workflowId);
    if (!workflow) return new Response("unknown workflow", { status: 404 });
    return this.env.Workflow.getByName(bridge.workflowId).fetch(request);
  }
}
