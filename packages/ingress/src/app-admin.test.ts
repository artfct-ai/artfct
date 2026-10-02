import { beforeEach, describe, expect, it } from "bun:test";
import { adminGet, harness, type Harness } from "../test/app-harness";
import { DEFAULT_INSTALL_LINK, FAKE_BINDINGS } from "../test/fake-orchestrator";

describe("linear install", () => {
  describe("an admin who asks for the install link", () => {
    let app: Harness;
    let response: Response;

    beforeEach(async () => {
      app = harness();
      response = await app.request(adminGet("/linear/install"));
    });

    it("gets the link the orchestrator minted", async () => {
      expect(await response.json<unknown>()).toEqual(DEFAULT_INSTALL_LINK);
    });

    it("asks for one link, naming the callback it serves", () => {
      expect(app.rpc.installLinks).toEqual([
        { redirect_uri: "http://ingress/linear/oauth/callback" },
      ]);
    });
  });

  describe("an orchestrator that can mint no link", () => {
    let response: Response;

    beforeEach(async () => {
      const app = harness({ installLink: { error: "LINEAR_CLIENT_ID is not set" } });
      response = await app.request(adminGet("/linear/install"));
    });

    it("answers 503", () => {
      expect(response.status).toBe(503);
    });

    it("hands the reason back", async () => {
      expect(await response.json<unknown>()).toEqual({ error: "LINEAR_CLIENT_ID is not set" });
    });
  });

  describe("a callback that completes the install", () => {
    let app: Harness;
    let response: Response;

    beforeEach(async () => {
      app = harness();
      response = await app.request("http://ingress/linear/oauth/callback?code=c1&state=s1");
    });

    it("answers 200", () => {
      expect(response.status).toBe(200);
    });

    it("names the workspace and the app user", async () => {
      expect(await response.text()).toContain("Installed in Acme as app user app1");
    });

    it("passes the code, the state, and the callback to the orchestrator", () => {
      expect(app.rpc.installs).toEqual([
        { code: "c1", state: "s1", redirect_uri: "http://ingress/linear/oauth/callback" },
      ]);
    });
  });

  describe("a callback for an install that cannot complete", () => {
    let app: Harness;

    beforeEach(() => {
      app = harness({ install: { installed: false, error: "state is invalid" } });
    });

    describe("a callback Linear refused", () => {
      let response: Response;

      beforeEach(async () => {
        response = await app.request("http://ingress/linear/oauth/callback?error=access_denied");
      });

      it("answers 400", () => {
        expect(response.status).toBe(400);
      });

      it("names the refusal", async () => {
        expect(await response.text()).toBe("Linear refused the install: access_denied");
      });
    });

    describe("a callback the orchestrator could not finish", () => {
      let response: Response;

      beforeEach(async () => {
        response = await app.request("http://ingress/linear/oauth/callback?code=c1&state=s1");
      });

      it("answers 400", () => {
        expect(response.status).toBe(400);
      });

      it("names the failure", async () => {
        expect(await response.text()).toBe("Install failed: state is invalid");
      });

      it("costs the orchestrator one call", () => {
        expect(app.rpc.installs).toHaveLength(1);
      });
    });

    describe("a callback with neither a code nor an error", () => {
      it("answers 400", async () => {
        const response = await app.request("http://ingress/linear/oauth/callback");
        expect(response.status).toBe(400);
      });
    });
  });
});

describe("admin routes", () => {
  const DUMPS = ["/workflows/wf_1", "/workflows/wf_1/debug", "/bindings"];

  describe("a deploy, which sets no ADMIN_DEBUG", () => {
    let app: Harness;
    let dumps: Response[];

    beforeEach(async () => {
      app = harness();
      dumps = await Promise.all(DUMPS.map((path) => app.request(adminGet(path))));
    });

    it("answers 404 to every dump, token and all", () => {
      expect(dumps.map((response) => response.status)).toEqual([404, 404, 404]);
    });

    it("reaches the orchestrator for none of them", () => {
      expect(app.rpc.statusIds).toEqual([]);
    });

    it("keeps the install link behind the token", async () => {
      expect((await app.request(adminGet("/linear/install", "nope"))).status).toBe(401);
    });
  });

  describe("local dev, which sets ADMIN_DEBUG", () => {
    let app: Harness;
    let debug: Response;
    let bindings: Response;

    beforeEach(async () => {
      app = harness({ adminDebug: true });
      debug = await app.request(adminGet("/workflows/wf_2/debug"));
      bindings = await app.request(adminGet("/bindings"));
    });

    it("answers the debug state the orchestrator reported", async () => {
      expect(await debug.json<unknown>()).toEqual({ workflow_id: "wf_2", debug: true });
    });

    it("hands back the bindings the orchestrator holds", async () => {
      expect(await bindings.json<unknown>()).toEqual(FAKE_BINDINGS);
    });

    it("passes the workflow id to the debug call", () => {
      expect(app.rpc.debugIds).toEqual(["wf_2"]);
    });

    it("rejects a wrong token", async () => {
      expect((await app.request(adminGet("/bindings", "nope"))).status).toBe(401);
    });
  });
});

describe("bridge route", () => {
  describe("a websocket upgrade for a workflow", () => {
    const received: Request[] = [];
    let response: Response;

    beforeEach(async () => {
      received.length = 0;
      const app = harness({
        async fetch(request) {
          received.push(request);
          return new Response("socket");
        },
      });
      response = await app.request("http://ingress/bridge/wf_1/wf_1.1", {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          authorization: "Bearer t0k",
          "x-agents-lifecycle-props": "e30=",
        },
      });
    });

    it("answers with what the orchestrator returned", async () => {
      expect(await response.text()).toBe("socket");
    });

    it("hands the url over", () => {
      expect(received[0]?.url).toBe("http://ingress/bridge/wf_1/wf_1.1");
    });

    it("hands the upgrade and the token over and no other header", () => {
      expect([...(received[0]?.headers ?? [])]).toEqual([
        ["authorization", "Bearer t0k"],
        ["upgrade", "websocket"],
      ]);
    });
  });
});
