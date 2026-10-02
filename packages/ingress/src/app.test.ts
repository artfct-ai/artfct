import { beforeEach, describe, expect, it } from "bun:test";
import {
  fakeDocuments,
  githubPost,
  harness,
  linearPost,
  notionPost,
  post,
  type Harness,
} from "../test/app-harness";
import { DEFAULT_DELIVERY } from "../test/fake-orchestrator";
import {
  githubPullRequest,
  linearDocumentComment,
  LINEAR_APP_USER_ID,
  linearSessionCreated,
  notionCommentCreated,
  NOTION_PAGE_ID,
  ORCHESTRATOR_BRANCH,
} from "../test/webhook-fixtures";

describe("healthz", () => {
  let response: Response;

  beforeEach(async () => {
    response = await harness().request("/healthz");
  });

  it("answers 200", () => {
    expect(response.status).toBe(200);
  });

  it("answers ok", async () => {
    expect(await response.text()).toBe("ok");
  });
});

describe("github webhook", () => {
  const opened = JSON.stringify(githubPullRequest("opened"));
  let app: Harness;

  beforeEach(() => {
    app = harness();
  });

  describe("a request with a bad signature", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(
        post("/webhooks/github", opened, { "x-hub-signature-256": "sha256=deadbeef" }),
      );
    });

    it("is rejected", () => {
      expect(response.status).toBe(401);
    });

    it("says the signature is bad", async () => {
      expect(await response.text()).toBe("bad signature");
    });

    it("delivers nothing, since the body is never read", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("the ping GitHub sends when a hook is installed", () => {
    let response: Response;

    beforeEach(async () => {
      const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
      response = await app.request(await githubPost(body, { "x-github-event": "ping" }));
    });

    it("is answered", async () => {
      expect(await response.json<unknown>()).toEqual({ ok: true });
    });

    it("delivers nothing", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("a malformed body that is correctly signed", () => {
    it("answers 400", async () => {
      const response = await app.request(await githubPost("{nope", { "x-github-event": "push" }));
      expect(response.status).toBe(400);
    });
  });

  describe("two pull request deliveries, one with a delivery header and one without", () => {
    beforeEach(async () => {
      await app.request(
        await githubPost(opened, { "x-github-event": "pull_request", "x-github-delivery": "d-1" }),
      );
      await app.request(await githubPost(opened, { "x-github-event": "pull_request" }));
    });

    it("uses the delivery header as the event id", () => {
      expect(app.rpc.deliveries[0]?.id).toBe("github:d-1");
    });

    it("falls back to a uuid when the header is missing", () => {
      expect(app.rpc.deliveries[1]?.id).toMatch(/^github:[0-9a-f]{8}-[0-9a-f-]{27}$/);
    });
  });

  describe("a pull request opened on an orchestrator branch", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(
        await githubPost(opened, { "x-github-event": "pull_request", "x-github-delivery": "d-1" }),
      );
    });

    it("reports what the orchestrator answered", async () => {
      expect(await response.json<unknown>()).toEqual(DEFAULT_DELIVERY);
    });

    it("delivers one event", () => {
      expect(app.rpc.deliveries).toHaveLength(1);
    });

    it("delivers it as a pr_event", () => {
      expect(app.rpc.deliveries[0]?.kind).toBe("pr_event");
    });

    it("binds to the pull request and to the branch", () => {
      expect(app.rpc.deliveries[0]?.bindings).toEqual([
        { source: "code_pull", repo: "acme/app", number: 7 },
        { source: "code_branch", repo: "acme/app", branch: ORCHESTRATOR_BRANCH },
      ]);
    });

    it("names the sender as the actor", () => {
      expect(app.rpc.deliveries[0]?.actor?.person_id).toBe("p_sam");
    });
  });

  describe("a pull request on a branch no task owns", () => {
    let response: Response;

    beforeEach(async () => {
      const feature = githubPullRequest("opened", {
        head: { ref: "feature/x", sha: "abc", repo: { full_name: "acme/app" } },
      });
      response = await app.request(
        await githubPost(JSON.stringify(feature), { "x-github-event": "pull_request" }),
      );
    });

    it("reports the reason it was ignored", async () => {
      expect(await response.json<unknown>()).toEqual({ ignored: "not an orchestrator branch" });
    });

    it("delivers nothing", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });
});

describe("linear webhook", () => {
  const created = JSON.stringify(linearSessionCreated());
  let app: Harness;

  beforeEach(() => {
    app = harness();
  });

  describe("a request with a bad signature", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(
        post("/webhooks/linear", "not json", { "linear-signature": "deadbeef" }),
      );
    });

    it("is rejected", () => {
      expect(response.status).toBe(401);
    });

    it("delivers nothing, since the body is never read", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });

    it("asks the orchestrator nothing", () => {
      expect(app.rpc.queries).toEqual([]);
    });
  });

  describe("a correctly signed body that is not JSON", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(await linearPost("not json"));
    });

    it("is rejected, since the signed timestamp cannot be read", () => {
      expect(response.status).toBe(401);
    });

    it("delivers nothing", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("a session of a workspace the deployment is not installed in", () => {
    let response: Response;

    beforeEach(async () => {
      const payload = { ...linearSessionCreated(), organizationId: "org_other" };
      response = await app.request(await linearPost(JSON.stringify(payload)));
    });

    it("answers the reason it was ignored", async () => {
      expect(await response.json<unknown>()).toEqual({ ignored: "another workspace" });
    });

    it("delivers nothing", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });

    it("looks no identity up", () => {
      expect(app.rpc.queries).toEqual([]);
    });
  });

  describe("a session that arrives before the install", () => {
    it("is ignored", async () => {
      app = harness({ workspace: null });
      const response = await app.request(await linearPost(created));
      expect(await response.json<unknown>()).toEqual({ ignored: "another workspace" });
    });
  });

  describe("a session the agent's own delegation opened", () => {
    let response: Response;

    beforeEach(async () => {
      const payload = linearSessionCreated();
      payload.agentSession.creator = null;
      response = await app.request(await linearPost(JSON.stringify(payload)));
    });

    it("reports what the orchestrator answered", async () => {
      expect(await response.json<unknown>()).toEqual(DEFAULT_DELIVERY);
    });

    it("looks no identity up, since there is no creator", () => {
      expect(app.rpc.queries).toEqual([]);
    });

    it("delivers one event", () => {
      expect(app.rpc.deliveries).toHaveLength(1);
    });

    it("delivers it without an actor", () => {
      expect(app.rpc.deliveries[0]?.actor).toBeNull();
    });
  });

  describe("a session a person created", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(await linearPost(created));
    });

    it("reports what the orchestrator answered", async () => {
      expect(await response.json<unknown>()).toEqual(DEFAULT_DELIVERY);
    });

    it("delivers one event", () => {
      expect(app.rpc.deliveries).toHaveLength(1);
    });

    it("takes the event id from the delivery header", () => {
      expect(app.rpc.deliveries[0]?.id).toBe("linear:delivery-1");
    });

    it("delivers it as a start", () => {
      expect(app.rpc.deliveries[0]?.kind).toBe("start");
    });

    it("titles the work with the issue identifier", () => {
      expect(app.rpc.deliveries[0]?.title).toBe("ENG-1 Fix login");
    });

    it("carries the guidance from the issue", () => {
      expect(app.rpc.deliveries[0]?.text).toContain("Guidance:\nKeep the change small.");
    });

    it("resolves the creator's email", () => {
      expect(app.rpc.deliveries[0]?.actor?.email).toBe("dev@acme.test");
    });

    it("replies on the session", () => {
      expect(app.rpc.deliveries[0]?.reply_to).toEqual({
        source: "tracker",
        session_id: "sess1",
        issue_id: "iss1",
        team_id: "t1",
      });
    });
  });

  describe("comments inside a document", () => {
    beforeEach(() => {
      app = harness({ appUserId: LINEAR_APP_USER_ID });
    });

    describe("a comment the installed app wrote", () => {
      let response: Response;

      beforeEach(async () => {
        const payload = linearDocumentComment(LINEAR_APP_USER_ID, "Review: approved");
        response = await app.request(await linearPost(JSON.stringify(payload)));
      });

      it("answers the reason it was ignored", async () => {
        expect(await response.json<unknown>()).toEqual({ ignored: "comment no person wrote" });
      });

      it("delivers nothing, so the agent never answers its own comment", () => {
        expect(app.rpc.deliveries).toEqual([]);
      });
    });

    describe("a comment a person wrote", () => {
      beforeEach(async () => {
        const payload = linearDocumentComment("u1", "Rework the second section.");
        await app.request(await linearPost(JSON.stringify(payload)));
      });

      it("delivers it as feedback on the page", () => {
        expect(app.rpc.deliveries[0]?.kind).toBe("feedback");
      });

      it("carries the comment to the agent", () => {
        expect(app.rpc.deliveries[0]?.text).toBe("Rework the second section.");
      });

      it("binds it to the document the artifact lives in", () => {
        expect(app.rpc.deliveries[0]?.bindings).toEqual([
          { source: "docs_page", external_id: "content1" },
        ]);
      });
    });

    describe("the same person's comment delivered twice", () => {
      let repeat: Response;

      beforeEach(async () => {
        const payload = JSON.stringify(linearDocumentComment("u1", "Rework the second section."));
        await app.request(await linearPost(payload));
        repeat = await app.request(await linearPost(payload));
      });

      it("gives both deliveries the same event id, so the orchestrator drops the second", () => {
        expect(app.rpc.deliveries.map((event) => event.id)).toEqual([
          "linear:delivery-1",
          "linear:delivery-1",
        ]);
      });

      it("reports what the orchestrator answered, and writes nothing back to Linear", async () => {
        expect(await repeat.json<unknown>()).toEqual(DEFAULT_DELIVERY);
      });
    });
  });
});

describe("notion webhook", () => {
  const comment = JSON.stringify(notionCommentCreated());
  let app: Harness;

  beforeEach(() => {
    app = harness();
  });

  describe("a subscription handshake on a deployment that holds the verification token", () => {
    let response: Response;

    beforeEach(async () => {
      const body = JSON.stringify({ verification_token: "secret_v" });
      response = await app.request(post("/webhooks/notion", body));
    });

    it("is refused", () => {
      expect(response.status).toBe(409);
    });
  });

  describe("an unsigned event that is not the handshake", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(post("/webhooks/notion", comment));
    });

    it("is rejected", () => {
      expect(response.status).toBe(401);
    });

    it("says the signature is bad", async () => {
      expect(await response.text()).toBe("bad signature");
    });
  });

  describe("a signed comment with no Notion token configured", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(await notionPost(comment));
    });

    it("fails so Notion delivers it again", () => {
      expect(response.status).toBe(503);
    });

    it("reports the missing token", async () => {
      expect(await response.text()).toBe("NOTION_TOKEN not configured");
    });
  });

  describe("a signed event of a type nobody handles", () => {
    let response: Response;

    beforeEach(async () => {
      response = await app.request(
        await notionPost(JSON.stringify({ id: "evt2", type: "page.content_updated" })),
      );
    });

    it("reports the type it ignored", async () => {
      expect(await response.json<unknown>()).toEqual({ ignored: "page.content_updated" });
    });

    it("delivers nothing", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("a signed comment with a documents client available", () => {
    let docs: ReturnType<typeof fakeDocuments>;
    let response: Response;

    beforeEach(async () => {
      docs = fakeDocuments();
      app = harness({ clients: { docs } });
      response = await app.request(await notionPost(comment));
    });

    it("reports what the orchestrator answered", async () => {
      expect(await response.json<unknown>()).toEqual(DEFAULT_DELIVERY);
    });

    it("fetches the comment and then its author", () => {
      expect(docs.calls).toEqual([
        { method: "fetchComment", args: ["cmt1"] },
        { method: "userEmail", args: ["n1"] },
      ]);
    });

    it("asks the orchestrator to resolve the author", () => {
      expect(app.rpc.queries).toEqual([
        { source: "docs", user: { id: "n1", email: "dev@acme.test" } },
      ]);
    });

    it("delivers the comment as feedback bound to the page", () => {
      expect(app.rpc.deliveries[0]).toMatchObject({
        id: "notion:evt1",
        kind: "feedback",
        page: { page_id: NOTION_PAGE_ID.replace(/-/g, ""), comment_id: "cmt1" },
        text: "lgtm, ship it",
        bindings: [{ source: "docs_page", external_id: NOTION_PAGE_ID.replace(/-/g, "") }],
        reply_to: { source: "docs", page_id: NOTION_PAGE_ID },
        actor: { person_id: "p_n1", email: "dev@acme.test" },
      });
    });
  });
});
