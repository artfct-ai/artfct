import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { fakeChat, harness, slackPost, type Harness } from "../test/app-harness";
import { slackMemberJoined, slackMention, slackThreadReply } from "../test/webhook-fixtures";
import { GREETING } from "./slack-greeting";

describe("slack webhook", () => {
  const TEXT = "<@UBOT> fix the flaky test in <https://github.com/acme/app|acme/app>";

  describe("a channel mention, with a chat client available", () => {
    let app: Harness;
    let chat: ReturnType<typeof fakeChat>;
    let response: Response;

    beforeEach(async () => {
      chat = fakeChat();
      app = harness({ clients: { chat } });
      response = await app.request(await slackPost(JSON.stringify(slackMention(TEXT))));
    });

    it("answers Slack at once", () => {
      expect(response.status).toBe(200);
    });

    it("tells Slack not to retry", () => {
      expect(response.headers.get("x-slack-no-retry")).toBe("1");
    });

    it("answers ok", async () => {
      expect(await response.json<unknown>()).toEqual({ ok: true });
    });

    describe("once the background work has settled", () => {
      beforeEach(async () => {
        await app.settle();
      });

      it("asks the chat client for the sender", () => {
        expect(chat.calls).toEqual([{ method: "user", args: ["U1"] }]);
      });

      it("asks the orchestrator to resolve the sender", () => {
        expect(app.rpc.queries).toEqual([
          { source: "chat", user: { id: "U1", email: "dev@acme.test", member_of_team: "T1" } },
        ]);
      });

      it("delivers one event", () => {
        expect(app.rpc.deliveries).toHaveLength(1);
      });

      it("delivers the mention as a start bound to its own thread", () => {
        expect(app.rpc.deliveries[0]).toMatchObject({
          id: "slack:Ev1",
          kind: "start",
          text: "fix the flaky test in https://github.com/acme/app",
          links: ["https://github.com/acme/app"],
          bindings: [{ source: "chat_thread", external_id: "C1:1756893600.000100" }],
          reply_to: { source: "chat", channel: "C1", thread: "1756893600.000100" },
          acknowledge: { message: "1756893600.000100", user: "U1" },
          actor: { person_id: "p_U1", email: "dev@acme.test" },
        });
      });
    });
  });

  describe("a thread reply that links a pull request", () => {
    it("binds to its own thread alone", async () => {
      const app = harness();
      const text = "continue <https://github.com/acme/app/pull/12|#12> and add docs";
      await app.request(await slackPost(JSON.stringify(slackThreadReply(text))));
      await app.settle();
      expect(app.rpc.deliveries[0]?.bindings).toEqual([
        { source: "chat_thread", external_id: "C1:1756893600.000100" },
      ]);
    });
  });

  describe("a channel mention that links a pull request", () => {
    it("keeps the work on its own thread, whatever it links", async () => {
      const app = harness();
      const text = "<@UBOT> continue <https://github.com/acme/app/pull/12|#12> and add docs";
      await app.request(await slackPost(JSON.stringify(slackMention(text))));
      await app.settle();
      expect(app.rpc.deliveries[0]).toMatchObject({
        kind: "start",
        bindings: [{ source: "chat_thread", external_id: "C1:1756893600.000100" }],
        links: ["https://github.com/acme/app/pull/12"],
      });
    });
  });

  describe("a thread reply aimed at somebody else", () => {
    let app: Harness;
    let response: Response;

    beforeEach(async () => {
      app = harness({ clients: { chat: fakeChat() } });
      const reply = slackThreadReply("<@ULINEAR> can you link this thread to ENG-41?");
      response = await app.request(await slackPost(JSON.stringify(reply)));
      await app.settle();
    });

    it("still answers Slack at once", () => {
      expect(response.status).toBe(200);
    });

    it("delivers nothing", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("a thread reply that tags nobody", () => {
    it("delivers it as a prompt on the thread", async () => {
      const app = harness({ clients: { chat: fakeChat() } });
      await app.request(await slackPost(JSON.stringify(slackThreadReply("also update the docs"))));
      await app.settle();
      expect(app.rpc.deliveries[0]).toMatchObject({
        kind: "prompt",
        text: "also update the docs",
        bindings: [{ source: "chat_thread", external_id: "C1:1756893600.000100" }],
      });
    });
  });

  describe("this app being added to a channel", () => {
    let app: Harness;
    let chat: ReturnType<typeof fakeChat>;
    let response: Response;

    beforeEach(async () => {
      chat = fakeChat();
      app = harness({ clients: { chat } });
      response = await app.request(await slackPost(JSON.stringify(slackMemberJoined("UBOT"))));
      await app.settle();
    });

    it("answers Slack at once", () => {
      expect(response.status).toBe(200);
    });

    it("posts the greeting in the channel, outside any thread", () => {
      expect(chat.calls).toEqual([{ method: "postChannelMessage", args: ["C1", GREETING] }]);
    });

    it("delivers nothing to the orchestrator", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("another member being added to the same channel", () => {
    let app: Harness;
    let chat: ReturnType<typeof fakeChat>;

    beforeEach(async () => {
      chat = fakeChat();
      app = harness({ clients: { chat } });
      await app.request(await slackPost(JSON.stringify(slackMemberJoined("U2"))));
      await app.settle();
    });

    it("posts nothing", () => {
      expect(chat.calls).toEqual([]);
    });

    it("delivers nothing to the orchestrator", () => {
      expect(app.rpc.deliveries).toEqual([]);
    });
  });

  describe("a second delivery of the join, which Slack marks as a retry", () => {
    it("posts nothing, so the channel gets one greeting", async () => {
      const chat = fakeChat();
      const app = harness({ clients: { chat } });
      const body = JSON.stringify(slackMemberJoined("UBOT"));
      await app.request(await slackPost(body, { "x-slack-retry-num": "1" }));
      await app.settle();
      expect(chat.calls).toEqual([]);
    });
  });

  describe("a delivery the orchestrator refuses", () => {
    let app: Harness;
    let response: Response;
    let logged: string[];
    let restore: () => void;

    beforeEach(async () => {
      logged = [];
      const spy = spyOn(console, "error").mockImplementation((message: string) => {
        logged.push(message);
      });
      restore = () => spy.mockRestore();
      app = harness({ deliverError: new Error("orchestrator down") });
      response = await app.request(await slackPost(JSON.stringify(slackMention(TEXT))));
    });

    afterEach(() => {
      restore();
    });

    it("still answers Slack at once", () => {
      expect(response.status).toBe(200);
    });

    it("settles the background work instead of throwing", async () => {
      await expect(app.settle()).resolves.toBeDefined();
    });

    it("logs the failure against the event id", async () => {
      await app.settle();
      expect(logged).toEqual(["slack Ev1: Error: orchestrator down"]);
    });
  });
});
