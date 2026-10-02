import { Hono, type ExecutionContext } from "hono";
import { hmacSha256Hex } from "@artfct-ai/adapters/hmac";
import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import { FakeDocuments } from "@artfct-ai/adapters/test/fake-documents";
import type { ChannelClients } from "../src/clients";
import type { Env, HonoEnv } from "../src/env";
import app from "../src/index";
import {
  fakeOrchestrator,
  type FakeOrchestrator,
  type FakeOrchestratorOptions,
} from "./fake-orchestrator";

/** The secrets the ingress Worker reads, with values only the tests know. */
export const SECRETS = {
  ADMIN_TOKEN: "admin-test",
  GITHUB_WEBHOOK_SECRET: "github-test",
  LINEAR_WEBHOOK_SECRET: "linear-test",
  SLACK_SIGNING_SECRET: "slack-test",
  NOTION_VERIFICATION_TOKEN: "notion-test",
};

const NO_CLIENTS: ChannelClients = { chat: null, docs: null };

export type Harness = {
  rpc: FakeOrchestrator;
  request: (input: Request | string, init?: RequestInit) => Promise<Response>;
  /** Resolves when every promise handed to `waitUntil` has settled. */
  settle: () => Promise<unknown>;
};

export type HarnessOptions = FakeOrchestratorOptions & {
  clients?: Partial<ChannelClients>;
  adminDebug?: boolean;
};

/**
 * The root app behind a wrapper that injects the channel clients. The orchestrator binding is
 * the fake, and `waitUntil` promises are collected so a test can wait for background work.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const rpc = fakeOrchestrator(options);
  const clients = { ...NO_CLIENTS, ...options.clients };
  const wrapper = new Hono<HonoEnv>();
  wrapper.use("*", async (ctx, next) => {
    ctx.set("clients", clients);
    await next();
  });
  wrapper.route("/", app);

  const env: Env = { ORCHESTRATOR: rpc, GITHUB_APP_LOGIN: "artfct", ...SECRETS };
  if (options.adminDebug) env.ADMIN_DEBUG = "true";
  const background: Promise<unknown>[] = [];
  const executionCtx: ExecutionContext = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  return {
    rpc,
    request: async (input, init) => wrapper.request(input, init, env, executionCtx),
    settle: () => Promise.all(background),
  };
}

/** A JSON POST to one of the ingress paths. */
export function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`http://ingress${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** A webhook POST signed the way GitHub signs one. */
export async function githubPost(body: string, headers: Record<string, string> = {}) {
  const signature = `sha256=${await hmacSha256Hex(SECRETS.GITHUB_WEBHOOK_SECRET, body)}`;
  return post("/webhooks/github", body, { "x-hub-signature-256": signature, ...headers });
}

/** A webhook POST signed the way Linear signs one, with a delivery header. */
export async function linearPost(body: string, headers: Record<string, string> = {}) {
  const signature = await hmacSha256Hex(SECRETS.LINEAR_WEBHOOK_SECRET, body);
  return post("/webhooks/linear", body, {
    "linear-signature": signature,
    "linear-delivery": "delivery-1",
    ...headers,
  });
}

/** A webhook POST signed the way Slack signs one, with a fresh timestamp. */
export async function slackPost(body: string, headers: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const base = `v0:${timestamp}:${body}`;
  const signature = `v0=${await hmacSha256Hex(SECRETS.SLACK_SIGNING_SECRET, base)}`;
  return post("/webhooks/slack", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
    ...headers,
  });
}

/** A webhook POST signed the way Notion signs one. */
export async function notionPost(body: string) {
  const signature = `sha256=${await hmacSha256Hex(SECRETS.NOTION_VERIFICATION_TOKEN, body)}`;
  return post("/webhooks/notion", body, { "x-notion-signature": signature });
}

/** A GET under `/admin` carrying the bearer token. */
export function adminGet(path: string, token = SECRETS.ADMIN_TOKEN) {
  return new Request(`http://ingress/admin${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** A chat fake that knows one user. */
export function fakeChat(): FakeChat {
  return new FakeChat({
    users: { U1: { id: "U1", email: "dev@acme.test", member_of_team: "T1" } },
  });
}

/** A documents fake that serves one comment without an author email, and the author's profile. */
export function fakeDocuments(): FakeDocuments {
  return new FakeDocuments({
    comments: {
      cmt1: {
        text: "lgtm, ship it",
        author: { id: "n1", email: null },
        mentions: [],
      },
    },
    emails: { n1: "dev@acme.test" },
  });
}
