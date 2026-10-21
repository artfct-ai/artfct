import { createHmac } from "node:crypto";
import { describe, expect, it, spyOn } from "bun:test";
import { BRIDGE_TOKEN_HEADER } from "@artfct-ai/acp/bridge-token";
import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import { propertyRuns, propertyTimeoutMs } from "@artfct-ai/adapters/test/property-runs";
import fc from "fast-check";
import { harness, post } from "../../test/app-harness";
import {
  INGRESS_SECRETS,
  ingressSecretsReachNoOutput,
  type IngressOutput,
  type IngressSecret,
} from "../../test/ingress-secret-invariants";
import {
  githubPullRequest,
  linearSessionCreated,
  notionCommentCreated,
  slackMemberJoined,
  slackMention,
} from "../../test/webhook-fixtures";

const RUNS = 1000;

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

type Vendor = "github" | "linear" | "slack" | "notion";

type Signing = "configured_secret" | "wrong_secret" | "unsigned";

type IngressRequest =
  | { route: "webhook"; vendor: Vendor; signing: Signing; text: string; slackEvent: SlackEvent }
  | { route: "notion_handshake"; offersConfiguredSecret: boolean; token: string }
  | {
      route: "admin";
      path: string;
      bearer: "configured_token" | "wrong_token" | "none";
      debug: boolean;
    }
  | { route: "linear_oauth_callback"; query: string }
  | { route: "bridge"; upgrade: boolean; token: string };

type SlackEvent = "mention" | "app_joined" | "url_verification";

type OrchestratorBehavior = {
  authorized: boolean;
  deliverFails: boolean;
  installFails: boolean;
  chatFails: boolean;
  documentsFails: boolean;
};

function secretMarker(name: IngressSecret): string {
  return `ingress-marker-${name}-4b7d`;
}

const SIGNING_SECRET_OF: Record<Vendor, IngressSecret> = {
  github: "GITHUB_WEBHOOK_SECRET",
  linear: "LINEAR_WEBHOOK_SECRET",
  slack: "SLACK_SIGNING_SECRET",
  notion: "NOTION_VERIFICATION_TOKEN",
};

const text = fc.string({ maxLength: 40 });

const rarely = fc.oneof({ arbitrary: fc.constant(false), weight: 3 }, fc.constant(true));

const signing = fc.oneof(
  { arbitrary: fc.constant<Signing>("configured_secret"), weight: 3 },
  fc.constantFrom<Signing>("wrong_secret", "unsigned"),
);

const ingressRequest: fc.Arbitrary<IngressRequest> = fc.oneof(
  {
    arbitrary: fc.record({
      route: fc.constant("webhook" as const),
      vendor: fc.constantFrom<Vendor>("github", "linear", "slack", "notion"),
      signing,
      text,
      slackEvent: fc.constantFrom<SlackEvent>("mention", "app_joined", "url_verification"),
    }),
    weight: 4,
  },
  fc.record({
    route: fc.constant("notion_handshake" as const),
    offersConfiguredSecret: fc.boolean(),
    token: text,
  }),
  fc.record({
    route: fc.constant("admin" as const),
    path: fc.constantFrom(
      "/linear/install",
      "/workflows/wf_1",
      "/conversations/cv_1/debug",
      "/bindings",
    ),
    bearer: fc.constantFrom("configured_token" as const, "wrong_token" as const, "none" as const),
    debug: fc.boolean(),
  }),
  fc.record({
    route: fc.constant("linear_oauth_callback" as const),
    query: fc.constantFrom("?code=c1&state=s1", "?error=access_denied", "?code=c1", ""),
  }),
  fc.record({ route: fc.constant("bridge" as const), upgrade: fc.boolean(), token: text }),
);

const orchestratorBehavior: fc.Arbitrary<OrchestratorBehavior> = fc.record({
  authorized: rarely.map((refused) => !refused),
  deliverFails: rarely,
  installFails: rarely,
  chatFails: rarely,
  documentsFails: rarely,
});

const secretChoice = fc.oneof(fc.constant([...INGRESS_SECRETS]), fc.subarray([...INGRESS_SECRETS]));

function hmacHex(secret: string, signed: string): string {
  return createHmac("sha256", secret).update(signed).digest("hex");
}

function slackPayload(event: SlackEvent, message: string): object {
  switch (event) {
    case "mention":
      return slackMention(`<@UBOT> ${message}`);
    case "app_joined":
      return slackMemberJoined("UBOT", "U1");
    case "url_verification":
      return { type: "url_verification", challenge: message };
    default: {
      const unreachable: never = event;
      throw new Error(`unhandled slack event ${String(unreachable)}`);
    }
  }
}

function webhookBody(vendor: Vendor, message: string, slackEvent: SlackEvent): string {
  switch (vendor) {
    case "github":
      return JSON.stringify(githubPullRequest("opened", { title: message }));
    case "linear":
      return JSON.stringify({
        ...linearSessionCreated(),
        guidance: message,
        webhookTimestamp: Date.now(),
      });
    case "slack":
      return JSON.stringify(slackPayload(slackEvent, message));
    case "notion":
      return JSON.stringify(notionCommentCreated());
    default: {
      const unreachable: never = vendor;
      throw new Error(`unhandled vendor ${String(unreachable)}`);
    }
  }
}

function signatureHeaders(vendor: Vendor, secret: string, body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  switch (vendor) {
    case "github":
      return {
        "x-hub-signature-256": `sha256=${hmacHex(secret, body)}`,
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
      };
    case "linear":
      return { "linear-signature": hmacHex(secret, body), "linear-delivery": "delivery-1" };
    case "slack":
      return {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${hmacHex(secret, `v0:${timestamp}:${body}`)}`,
      };
    case "notion":
      return { "x-notion-signature": `sha256=${hmacHex(secret, body)}` };
    default: {
      const unreachable: never = vendor;
      throw new Error(`unhandled vendor ${String(unreachable)}`);
    }
  }
}

function webhookRequest(
  request: Extract<IngressRequest, { route: "webhook" }>,
  secrets: Partial<Record<IngressSecret, string>>,
): Request {
  const body = webhookBody(request.vendor, request.text, request.slackEvent);
  const configured = secrets[SIGNING_SECRET_OF[request.vendor]];
  switch (request.signing) {
    case "unsigned":
      return post(`/webhooks/${request.vendor}`, body);
    case "wrong_secret":
      return post(
        `/webhooks/${request.vendor}`,
        body,
        signatureHeaders(request.vendor, "a-secret-ingress-never-held", body),
      );
    case "configured_secret":
      return post(
        `/webhooks/${request.vendor}`,
        body,
        signatureHeaders(request.vendor, configured ?? "an-unset-secret", body),
      );
    default: {
      const unreachable: never = request.signing;
      throw new Error(`unhandled signing ${String(unreachable)}`);
    }
  }
}

function adminBearer(
  bearer: Extract<IngressRequest, { route: "admin" }>["bearer"],
  secrets: Partial<Record<IngressSecret, string>>,
): Record<string, string> {
  switch (bearer) {
    case "configured_token":
      return { authorization: `Bearer ${secrets.ADMIN_TOKEN ?? ""}` };
    case "wrong_token":
      return { authorization: "Bearer not-the-admin-token" };
    case "none":
      return {};
    default: {
      const unreachable: never = bearer;
      throw new Error(`unhandled bearer ${String(unreachable)}`);
    }
  }
}

function httpRequest(
  request: IngressRequest,
  secrets: Partial<Record<IngressSecret, string>>,
): Request {
  switch (request.route) {
    case "webhook":
      return webhookRequest(request, secrets);
    case "notion_handshake": {
      const offered =
        request.offersConfiguredSecret && secrets.NOTION_VERIFICATION_TOKEN
          ? secrets.NOTION_VERIFICATION_TOKEN
          : `secret_${request.token}`;
      return post("/webhooks/notion", JSON.stringify({ verification_token: offered }));
    }
    case "admin":
      return new Request(`http://ingress/admin${request.path}`, {
        headers: adminBearer(request.bearer, secrets),
      });
    case "linear_oauth_callback":
      return new Request(`http://ingress/linear/oauth/callback${request.query}`);
    case "bridge": {
      const headers: Record<string, string> = { [BRIDGE_TOKEN_HEADER]: request.token };
      if (request.upgrade) headers.upgrade = "websocket";
      return new Request("http://ingress/bridge/wf_1/wf_1.1", { headers });
    }
    default: {
      const unreachable: never = request;
      throw new Error(`unhandled request ${String(unreachable)}`);
    }
  }
}

type Served = { status: number; outputs: { output: IngressOutput; text: string }[] };

async function serve(
  request: IngressRequest,
  secrets: Partial<Record<IngressSecret, string>>,
  behavior: OrchestratorBehavior,
): Promise<Served> {
  const chat = new FakeChat({
    users: { U1: { id: "U1", email: "dev@acme.test", member_of_team: "T1" } },
    failing: behavior.chatFails,
  });
  const documents = new FakeDocuments({
    comments: { cmt1: { text: "lgtm", author: { id: "n1", email: null }, mentions: [] } },
    emails: { n1: "dev@acme.test" },
    failing: behavior.documentsFails,
  });
  const forwarded: string[] = [];
  const app = harness({
    clients: { chat, documents },
    secrets: Object.fromEntries(INGRESS_SECRETS.map((name) => [name, secrets[name]])),
    adminDebug: request.route === "admin" && request.debug,
    authorized: behavior.authorized,
    ...(behavior.deliverFails ? { deliverError: new Error("the orchestrator is down") } : {}),
    ...(behavior.installFails
      ? { install: { installed: false, error: "the code was already used" } }
      : {}),
    fetch: async (forwardedRequest) => {
      forwarded.push(
        JSON.stringify({
          url: forwardedRequest.url,
          headers: [...forwardedRequest.headers.entries()],
        }),
      );
      return new Response(null, { status: 200 });
    },
  });
  const lines: string[] = [];
  const spies = CONSOLE_METHODS.map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  let response: Response;
  try {
    response = await app.request(httpRequest(request, secrets));
    await app.settle().catch(() => undefined);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const body = await response.text();
  return {
    status: response.status,
    outputs: [
      {
        output: "response",
        text: JSON.stringify({ headers: [...response.headers.entries()], body }),
      },
      ...lines.map((line) => ({ output: "console" as const, text: line })),
      ...app.rpc.deliveries.map((event) => ({
        output: "delivery" as const,
        text: JSON.stringify(event),
      })),
      ...app.rpc.queries.map((query) => ({
        output: "identity_query" as const,
        text: JSON.stringify(query),
      })),
      ...[
        ...app.rpc.installLinks,
        ...app.rpc.installs,
        ...app.rpc.statusIds,
        ...app.rpc.debugIds,
        ...forwarded,
      ].map((call) => ({ output: "orchestrator_call" as const, text: JSON.stringify(call) })),
      ...chat.calls.map((call) => ({ output: "chat_call" as const, text: JSON.stringify(call) })),
      ...documents.calls.map((call) => ({
        output: "documents_call" as const,
        text: JSON.stringify(call),
      })),
    ],
  };
}

describe("ingress secret invariants", () => {
  it(
    "no route sends a secret to a response, a log line, a delivery, or any other call",
    async () => {
      let refusedWithSecretSet = 0;
      let handshakesRefused = 0;
      let callbacksFailed = 0;
      let delivered = 0;
      await fc.assert(
        fc.asyncProperty(
          secretChoice,
          ingressRequest,
          orchestratorBehavior,
          async (secretsSet, request, behavior) => {
            const secrets = Object.fromEntries(
              secretsSet.map((name) => [name, secretMarker(name)]),
            );
            const served = await serve(request, secrets, behavior);
            if (served.status >= 400 && secretsSet.length > 0) refusedWithSecretSet++;
            if (served.status === 409) handshakesRefused++;
            if (served.outputs.some(({ output }) => output === "delivery")) delivered++;
            if (served.outputs.some(({ text: line }) => line.startsWith("slack Ev1:")))
              callbacksFailed++;
            ingressSecretsReachNoOutput({
              route: JSON.stringify(request),
              secrets,
              outputs: served.outputs,
            });
          },
        ),
        propertyRuns("ingress secrets", RUNS),
      );
      expect(refusedWithSecretSet).toBeGreaterThan(0);
      expect(handshakesRefused).toBeGreaterThan(0);
      expect(callbacksFailed).toBeGreaterThan(0);
      expect(delivered).toBeGreaterThan(0);
    },
    propertyTimeoutMs(30_000, RUNS),
  );
});
