import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { hmacSha256Hex } from "@artfct-ai/adapters/hmac";
import type { Env } from "../env";
import { DEFAULT_WORKSPACE, fakeOrchestrator } from "../../test/fake-orchestrator";
import { adminRoutes } from "./admin";
import { bridgeRoutes } from "./bridge";
import { githubRoutes } from "./github";
import { linearRoutes } from "./linear";
import { notionRoutes } from "./notion";
import { slackRoutes } from "./slack";

const SLACK_SECRET = "slack-test";
const LINEAR_SECRET = "linear-test";

const env: Env = {
  ORCHESTRATOR: fakeOrchestrator(),
  GITHUB_APP_LOGIN: "artfct",
  ADMIN_TOKEN: "secret",
  SLACK_SIGNING_SECRET: SLACK_SECRET,
  LINEAR_WEBHOOK_SECRET: LINEAR_SECRET,
};

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return new Request(`http://ingress${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function signedSlackPost(body: string, headers: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${await hmacSha256Hex(SLACK_SECRET, `v0:${timestamp}:${body}`)}`;
  return post("/webhooks/slack", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
    ...headers,
  });
}

describe("slack route", () => {
  const handshake = JSON.stringify({ type: "url_verification", challenge: "abc" });

  describe("the url_verification handshake", () => {
    let response: Response;

    beforeEach(async () => {
      response = await slackRoutes.request(await signedSlackPost(handshake), undefined, env);
    });

    it("answers 200", () => {
      expect(response.status).toBe(200);
    });

    it("echoes the challenge back", async () => {
      expect(await response.json<unknown>()).toEqual({ challenge: "abc" });
    });
  });

  describe("an envelope that is not an event callback", () => {
    it("ignores it by its type", async () => {
      const body = JSON.stringify({ type: "app_rate_limited" });
      const response = await slackRoutes.request(await signedSlackPost(body), undefined, env);
      expect(await response.json<unknown>()).toEqual({ ignored: "app_rate_limited" });
    });
  });

  describe("a request Slack did not sign", () => {
    it("rejects it", async () => {
      const response = await slackRoutes.request(
        post("/webhooks/slack", handshake),
        undefined,
        env,
      );
      expect(response.status).toBe(401);
    });
  });

  describe("a signed request with no signing secret configured", () => {
    let response: Response;

    beforeEach(async () => {
      response = await slackRoutes.request(await signedSlackPost(handshake), undefined, {
        ...env,
        SLACK_SIGNING_SECRET: undefined,
      });
    });

    it("fails closed", () => {
      expect(response.status).toBe(401);
    });

    it("says the secret is missing", async () => {
      expect(await response.text()).toBe("signing secret not configured");
    });
  });

  describe("a malformed body", () => {
    it("answers 400", async () => {
      const response = await slackRoutes.request(await signedSlackPost("{nope"), undefined, env);
      expect(response.status).toBe(400);
    });
  });

  describe("a delivery Slack is retrying", () => {
    let response: Response;

    beforeEach(async () => {
      const body = JSON.stringify({ type: "event_callback", event_id: "Ev1", event: {} });
      response = await slackRoutes.request(
        await signedSlackPost(body, { "x-slack-retry-num": "1" }),
        undefined,
        env,
      );
    });

    it("answers 200", () => {
      expect(response.status).toBe(200);
    });

    it("tells Slack not to retry again", () => {
      expect(response.headers.get("x-slack-no-retry")).toBe("1");
    });

    it("drops the event", async () => {
      expect(await response.json<unknown>()).toEqual({ ignored: "retry" });
    });
  });
});

describe("github route", () => {
  describe("a request with no signing secret configured", () => {
    let response: Response;

    beforeEach(async () => {
      response = await githubRoutes.request(post("/webhooks/github", "{}"), undefined, env);
    });

    it("fails closed", () => {
      expect(response.status).toBe(401);
    });

    it("says the secret is missing", async () => {
      expect(await response.text()).toBe("signing secret not configured");
    });
  });
});

async function signedLinearPost(body: string) {
  const signature = await hmacSha256Hex(LINEAR_SECRET, body);
  return post("/webhooks/linear", body, { "linear-signature": signature });
}

async function requestLogging(request: Request): Promise<{ response: Response; logged: string[] }> {
  const logged: string[] = [];
  const spy = spyOn(console, "log").mockImplementation((message: string) => {
    logged.push(message);
  });
  try {
    return { response: await linearRoutes.request(request, undefined, env), logged };
  } finally {
    spy.mockRestore();
  }
}

describe("linear route", () => {
  describe("a request Linear did not sign", () => {
    let result: { response: Response; logged: string[] };

    beforeEach(async () => {
      const body = JSON.stringify({ type: "Issue", webhookTimestamp: Date.now() });
      result = await requestLogging(post("/webhooks/linear", body));
    });

    it("rejects it", () => {
      expect(result.response.status).toBe(401);
    });

    it("logs nothing", () => {
      expect(result.logged).toEqual([]);
    });
  });

  describe("a signed body that is not JSON", () => {
    it("fails the signature check", async () => {
      const { response } = await requestLogging(await signedLinearPost("{nope"));
      expect(response.status).toBe(401);
    });
  });

  describe("a signed event the mapper ignores", () => {
    let result: { response: Response; logged: string[] };

    beforeEach(async () => {
      const body = JSON.stringify({
        type: "Cycle",
        action: "create",
        organizationId: DEFAULT_WORKSPACE,
        webhookTimestamp: Date.now(),
      });
      result = await requestLogging(await signedLinearPost(body));
    });

    it("answers with the reason", async () => {
      expect(await result.response.json<unknown>()).toEqual({ ignored: "Cycle/create" });
    });

    it("logs nothing", () => {
      expect(result.logged).toEqual([]);
    });
  });
});

describe("notion route", () => {
  describe("the subscription handshake before the verification token is set", () => {
    let response: Response;
    let logged: string[];

    beforeEach(async () => {
      logged = [];
      const spy = spyOn(console, "log").mockImplementation((message: string) => {
        logged.push(message);
      });
      const body = JSON.stringify({ verification_token: "secret_handshake" });
      try {
        response = await notionRoutes.request(post("/webhooks/notion", body), undefined, env);
      } finally {
        spy.mockRestore();
      }
    });

    it("answers 200", () => {
      expect(response.status).toBe(200);
    });

    it("answers ok", async () => {
      expect(await response.json<unknown>()).toEqual({ ok: true });
    });

    it("logs the token with the secret to set it as", () => {
      expect(logged).toEqual([
        "notion verification token received. Set NOTION_VERIFICATION_TOKEN to: secret_handshake",
      ]);
    });
  });

  describe("the subscription handshake once the verification token is set", () => {
    let response: Response;
    let logged: string[];

    beforeEach(async () => {
      logged = [];
      const logSpy = spyOn(console, "log").mockImplementation((message: string) => {
        logged.push(message);
      });
      const errorSpy = spyOn(console, "error").mockImplementation((message: string) => {
        logged.push(message);
      });
      const body = JSON.stringify({ verification_token: "secret_handshake" });
      try {
        response = await notionRoutes.request(post("/webhooks/notion", body), undefined, {
          ...env,
          NOTION_VERIFICATION_TOKEN: "secret_current",
        });
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("is refused", () => {
      expect(response.status).toBe(409);
    });

    it("says the token is already set", async () => {
      expect(await response.text()).toBe("verification token already set");
    });

    it("logs the refusal without the token it was sent", () => {
      expect(logged).toEqual([
        "notion handshake refused. NOTION_VERIFICATION_TOKEN is already set.",
      ]);
    });
  });

  describe("a signed-looking event before the verification token is set", () => {
    let response: Response;

    beforeEach(async () => {
      const body = JSON.stringify({ id: "evt1", type: "comment.created" });
      response = await notionRoutes.request(
        post("/webhooks/notion", body, { "x-notion-signature": "sha256=deadbeef" }),
        undefined,
        env,
      );
    });

    it("fails closed", () => {
      expect(response.status).toBe(401);
    });

    it("says the secret is missing", async () => {
      expect(await response.text()).toBe("signing secret not configured");
    });
  });
});

describe("admin route", () => {
  describe("a request without the admin token", () => {
    it("rejects a request with no authorization header", async () => {
      const response = await adminRoutes.request("/linear/install", undefined, env);
      expect(response.status).toBe(401);
    });

    it("rejects a request with the wrong token", async () => {
      const response = await adminRoutes.request(
        "/linear/install",
        { headers: { authorization: "Bearer nope" } },
        env,
      );
      expect(response.status).toBe(401);
    });
  });
});

describe("bridge route", () => {
  describe("a plain request to the bridge path", () => {
    it("requires a websocket upgrade", async () => {
      const response = await bridgeRoutes.request("/bridge/wf_1/wf_1.1", undefined, env);
      expect(response.status).toBe(426);
    });
  });
});
