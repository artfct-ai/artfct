import type { Actor, InboundEvent } from "@artfct-ai/contracts/inbound";
import type {
  BindingRecord,
  Delivery,
  IdentityQuery,
  LinearInstallInput,
  LinearInstallLink,
  LinearInstallResult,
  OrchestratorRpc,
  VendorEvent,
  VendorEventDelivery,
  WorkflowSummary,
} from "@artfct-ai/contracts/types";

/** What a route delivered and asked. Tests read these instead of watching calls. */
export type FakeOrchestrator = OrchestratorRpc & {
  deliveries: InboundEvent[];
  /** Every vendor event a route handed over, in order. */
  vendorEvents: VendorEvent[];
  /** When each `deliver` returned and each `deliverVendorEvent` was called, in order. */
  timeline: Array<"deliver returned" | "deliverVendorEvent">;
  queries: IdentityQuery[];
  statusIds: string[];
  debugIds: string[];
  /** Every install link the admin route asked for. */
  installLinks: Array<{ redirect_uri: string }>;
  /** Every install the callback completed. */
  installs: LinearInstallInput[];
};

export type FakeOrchestratorOptions = {
  /** Every identity query resolves to a member unless false. */
  authorized?: boolean;
  /**
   * The install's app user. It resolves to nobody, as the orchestrator answers for its own app
   * user.
   */
  appUserId?: string;
  /** What `deliver` answers. */
  delivery?: Delivery;
  /** What `deliverVendorEvent` answers. */
  vendorEventDelivery?: VendorEventDelivery;
  /** When set, `deliver` throws this instead of answering. */
  deliverError?: Error;
  /** The microtask ticks `deliver` waits before it answers. */
  deliverTicks?: number;
  /** The workspace of the install `trackerInstall` answers. Null stands for a deployment without an install. */
  workspace?: string | null;
  /** What `linearInstall` answers. */
  install?: LinearInstallResult;
  /** What `linearInstallUrl` answers. */
  installLink?: LinearInstallLink;
  /** Answers the bridge upgrade. Without it `fetch` throws, so an unexpected call is loud. */
  fetch?: (request: Request) => Promise<Response>;
};

/** The delivery the fake answers when a test does not choose one. */
export const DEFAULT_DELIVERY: Delivery = {
  conversation_id: "cv_test",
  result: { ok: true },
};

/** Bindings the fake lists for admins. */
export const FAKE_BINDINGS: BindingRecord[] = [
  {
    source: "tracker_issue",
    external_id: "iss1",
    workflow_id: "wf_test",
    conversation_id: "cv_test",
    created_at: "2026-09-03T10:00:00.000Z",
  },
];

/** The workspace the fake is installed in when a test does not choose one. */
export const DEFAULT_WORKSPACE = "org_acme";

/** The install's app user when a test does not choose one. */
const DEFAULT_APP_USER_ID = "app1";

/** A workflow id the fake orchestrator never created, so its status is null. */
export const UNCREATED_WORKFLOW_ID = "wf_uncreated";

/** The install result the fake answers when a test does not choose one. */
const DEFAULT_INSTALL: LinearInstallResult = {
  installed: true,
  organization: "Acme",
  app_user_id: DEFAULT_APP_USER_ID,
};

/** The install link the fake hands out when a test does not choose one. */
export const DEFAULT_INSTALL_LINK: LinearInstallLink = {
  url: "https://linear.app/oauth/authorize?state=st1",
};

/** Orchestrator RPC fake for route tests. It records what it receives and answers canned data. */
export function fakeOrchestrator(options: FakeOrchestratorOptions = {}): FakeOrchestrator {
  const authorized = options.authorized ?? true;
  const fake: FakeOrchestrator = {
    deliveries: [],
    vendorEvents: [],
    timeline: [],
    queries: [],
    statusIds: [],
    debugIds: [],
    installLinks: [],
    installs: [],
    ...linearInstallHandlers(options),
    async deliver(event) {
      if (options.deliverError) throw options.deliverError;
      fake.deliveries.push(event);
      for (let tick = 0; tick < (options.deliverTicks ?? 0); tick++) await Promise.resolve();
      fake.timeline.push("deliver returned");
      return options.delivery ?? DEFAULT_DELIVERY;
    },
    async deliverVendorEvent(event) {
      fake.vendorEvents.push(event);
      fake.timeline.push("deliverVendorEvent");
      return options.vendorEventDelivery ?? { firings: 0 };
    },
    async resolveActor(query) {
      fake.queries.push(query);
      if (!authorized) return null;
      if (query.source === "tracker" && query.user.id === options.appUserId) return null;
      return actorFor(query);
    },
    async trackerInstall() {
      const workspace = options.workspace === undefined ? DEFAULT_WORKSPACE : options.workspace;
      if (workspace === null) return null;
      return { workspace_id: workspace, app_user_id: options.appUserId ?? DEFAULT_APP_USER_ID };
    },
    async status(workflowId) {
      fake.statusIds.push(workflowId);
      return workflowId === UNCREATED_WORKFLOW_ID ? null : summaryFor(workflowId);
    },
    async debug(conversationId) {
      fake.debugIds.push(conversationId);
      return { conversation_id: conversationId, debug: true };
    },
    async bindings() {
      return FAKE_BINDINGS;
    },
    async fetch(request) {
      if (!options.fetch) throw new Error(`unexpected ORCHESTRATOR.fetch(${request.url})`);
      return options.fetch(request);
    },
  };
  return fake;
}

/** The Linear install half of the fake. `this` is the fake, so the records land on it. */
function linearInstallHandlers(
  options: FakeOrchestratorOptions,
): Pick<FakeOrchestrator, "linearInstallUrl" | "linearInstall"> {
  return {
    async linearInstallUrl(this: FakeOrchestrator, input) {
      this.installLinks.push(input);
      return options.installLink ?? DEFAULT_INSTALL_LINK;
    },
    async linearInstall(this: FakeOrchestrator, input) {
      this.installs.push(input);
      return options.install ?? DEFAULT_INSTALL;
    },
  };
}

function actorFor(query: IdentityQuery): Actor {
  if (query.source === "code") {
    return { email: null, display_name: query.user.login };
  }
  return { email: query.user.email ?? null, display_name: query.user.name ?? null };
}

function summaryFor(workflowId: string): WorkflowSummary {
  return {
    workflow_id: workflowId,
    status: "running",
    stages: ["plan", "implement"],
    jobs: [],
    concurrency: 1,
    cost_usd: 0.25,
    repo: { full: "acme/app" },
    reason: null,
  };
}
