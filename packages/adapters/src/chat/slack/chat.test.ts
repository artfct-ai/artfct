import type { ChatUser } from "@artfct-ai/contracts/types";
import { WebAPIPlatformError } from "@slack/web-api";
import { beforeEach, describe, expect, it } from "bun:test";
import { fetchBody, fetchHeader, fetchUrl } from "../../../test/fetch";
import { SlackChat, splitSlackText } from "./chat";

type Call = {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  form: Record<string, string>;
};

function slackChat(answer: (url: string) => unknown = () => ({ ok: true }), apiUrl?: string) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: fetchUrl(input),
      method: init?.method ?? "GET",
      authorization: fetchHeader(init, "authorization"),
      contentType: fetchHeader(init, "content-type"),
      form: Object.fromEntries(new URLSearchParams(fetchBody(init))),
    });
    const answered = answer(fetchUrl(input));
    return answered instanceof Response ? answered : Response.json(answered);
  };
  return { chat: new SlackChat("xoxb-test", { fetch, apiUrl }), calls };
}

describe("splitSlackText", () => {
  it("keeps short text whole", () => {
    expect(splitSlackText("hello", 10)).toEqual(["hello"]);
  });

  it("splits at the last paragraph boundary under the limit", () => {
    expect(splitSlackText("one\n\ntwo\n\nthree", 9)).toEqual(["one\n\ntwo", "three"]);
  });

  it("falls back to a line boundary when no paragraph boundary fits", () => {
    expect(splitSlackText("abc\ndef\nghi", 8)).toEqual(["abc\ndef", "ghi"]);
  });

  it("cuts hard when no boundary fits", () => {
    expect(splitSlackText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("SlackChat requests", () => {
  describe("a reaction, a thread root read, and a user lookup", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat(() => ({ ok: true, ts: "9.9", messages: [] }));
      await slack.chat.addReaction("C1", "1.2", "eyes");
      await slack.chat.threadRootTs("C1", "1.2");
      await slack.chat.user("U1");
      calls = slack.calls;
    });

    it("sends one call for each method", () => {
      expect(calls).toHaveLength(3);
    });

    it("posts every call", () => {
      expect(calls.every((call) => call.method === "POST")).toBe(true);
    });

    it("carries the bot token on every call", () => {
      expect(calls.every((call) => call.authorization === "Bearer xoxb-test")).toBe(true);
    });

    it("sends every body as a form", () => {
      expect(calls.every((call) => call.contentType === "application/x-www-form-urlencoded")).toBe(
        true,
      );
    });
  });

  describe("a custom API URL", () => {
    it("sends the method to that host", async () => {
      const { chat, calls } = slackChat(() => ({ ok: true }), "https://slack.test/api");
      await chat.addReaction("C1", "1.2", "eyes");
      expect(calls[0]?.url).toBe("https://slack.test/api/reactions.add");
    });
  });
});

describe("SlackChat messages", () => {
  describe("a reply longer than one Slack message", () => {
    const paragraph = "x".repeat(3000);
    let calls: Call[];
    let first: { ts: string };

    beforeEach(async () => {
      const slack = slackChat(() => ({ ok: true, ts: "9.9" }));
      first = await slack.chat.postThreadReply("C1", "1.2", `${paragraph}\n\n${paragraph}`);
      calls = slack.calls;
    });

    it("returns the first message", () => {
      expect(first.ts).toBe("9.9");
    });

    it("sends one call for each part", () => {
      expect(calls).toHaveLength(2);
    });

    it("posts every part through chat.postMessage", () => {
      expect(calls.every((call) => call.url === "https://slack.com/api/chat.postMessage")).toBe(
        true,
      );
    });

    it("splits the text at the paragraph boundary", () => {
      expect(calls.map((call) => call.form.text)).toEqual([paragraph, paragraph]);
    });

    it("keeps every part in the same thread", () => {
      expect(calls.every((call) => call.form.thread_ts === "1.2")).toBe(true);
    });
  });

  describe("a thread message longer than one Slack message", () => {
    const text = "x".repeat(9000);
    let calls: Call[];
    let posted: { ts: string };

    beforeEach(async () => {
      const slack = slackChat(() => ({ ok: true, ts: "9.9" }));
      posted = await slack.chat.postThreadMessage("C1", "1.2", text);
      calls = slack.calls;
    });

    it("returns the message timestamp", () => {
      expect(posted).toEqual({ ts: "9.9" });
    });

    it("sends one call however long the text is", () => {
      expect(calls).toHaveLength(1);
    });

    it("posts the whole text in one form", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", thread_ts: "1.2", text });
    });
  });

  describe("a channel message", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat(() => ({ ok: true, ts: "9.9" }));
      await slack.chat.postChannelMessage("C1", "hello everyone");
      calls = slack.calls;
    });

    it("posts to chat.postMessage", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    });

    it("sends the channel and the text with no thread", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", text: "hello everyone" });
    });
  });

  describe("text that holds a Markdown link", () => {
    it("goes out as mrkdwn on every message path", async () => {
      const { chat, calls } = slackChat(() => ({ ok: true, ts: "9.9" }));
      const text = "[PR #47](https://github.com/acme/app/pull/47) merged.";
      const mrkdwn = "<https://github.com/acme/app/pull/47|PR #47> merged.";
      await chat.postThreadReply("C1", "1.2", text);
      await chat.postThreadMessage("C1", "1.2", text);
      await chat.updateMessage("C1", "1.5", text);
      expect(calls.map((call) => call.form.text)).toEqual([mrkdwn, mrkdwn, mrkdwn]);
    });
  });

  describe("updateMessage", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat();
      await slack.chat.updateMessage("C1", "1.5", "board v2");
      calls = slack.calls;
    });

    it("posts to chat.update", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/chat.update");
    });

    it("sends the channel, the timestamp, and the text", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", ts: "1.5", text: "board v2" });
    });
  });

  describe("deleteMessage", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat();
      await slack.chat.deleteMessage("C1", "1.5");
      calls = slack.calls;
    });

    it("posts to chat.delete", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/chat.delete");
    });

    it("sends the channel and the timestamp", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", ts: "1.5" });
    });
  });

  describe("addReaction", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat();
      await slack.chat.addReaction("C1", "1.2", "eyes");
      calls = slack.calls;
    });

    it("posts to reactions.add", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/reactions.add");
    });

    it("sends the channel, the timestamp, and the name", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", timestamp: "1.2", name: "eyes" });
    });
  });

  describe("removeReaction", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat();
      await slack.chat.removeReaction("C1", "1.2", "eyes");
      calls = slack.calls;
    });

    it("posts to reactions.remove", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/reactions.remove");
    });

    it("sends the channel, the timestamp, and the name", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", timestamp: "1.2", name: "eyes" });
    });
  });

  describe("a call Slack refuses", () => {
    it("surfaces the Slack error code", async () => {
      const { chat } = slackChat(() => ({ ok: false, error: "already_reacted" }));
      await expect(chat.addReaction("C1", "1.2", "eyes")).rejects.toThrow("already_reacted");
    });
  });
});

describe("SlackChat.isGone", () => {
  describe("an update of a message Slack no longer has", () => {
    let chat: SlackChat;
    let error: unknown;

    beforeEach(async () => {
      chat = slackChat(() => ({ ok: false, error: "message_not_found" })).chat;
      error = await chat.updateMessage("C1", "1.5", "board v2").catch((caught) => caught);
    });

    it("rejects with a platform error", () => {
      expect(error).toBeInstanceOf(WebAPIPlatformError);
    });

    it("reads the error as gone", () => {
      expect(chat.isGone(error)).toBe(true);
    });
  });

  describe("another platform error", () => {
    it("does not read as gone", async () => {
      const { chat } = slackChat(() => ({ ok: false, error: "channel_not_found" }));
      const error = await chat.updateMessage("C1", "1.5", "board v2").catch((caught) => caught);
      expect(chat.isGone(error)).toBe(false);
    });
  });

  describe("a value that is not a Slack platform error", () => {
    const chat = new SlackChat("xoxb-test");

    it("does not read a plain error with the same message as gone", () => {
      expect(chat.isGone(new Error("message_not_found"))).toBe(false);
    });

    it("does not read undefined as gone", () => {
      expect(chat.isGone(undefined)).toBe(false);
    });
  });
});

describe("SlackChat.setSessionStatus", () => {
  describe("a status with a title and an initiator", () => {
    let calls: Call[];

    beforeEach(async () => {
      const slack = slackChat();
      await slack.chat.setSessionStatus("C1", "1.2", "processing", {
        title: "t".repeat(250),
        initiatorUserId: "U1",
      });
      calls = slack.calls;
    });

    it("posts to agents.sessions.setStatus", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/agents.sessions.setStatus");
    });

    it("sends the session fields with the title cut to 200 characters", () => {
      expect(calls[0]?.form).toEqual({
        channel_id: "C1",
        thread_ts: "1.2",
        status: "processing",
        title: "t".repeat(200),
        initiator_user_id: "U1",
      });
    });
  });

  describe("a status without a title or an initiator", () => {
    it("omits the optional fields", async () => {
      const { chat, calls } = slackChat();
      await chat.setSessionStatus("C1", "1.2", "closed");
      expect(calls[0]?.form).toEqual({ channel_id: "C1", thread_ts: "1.2", status: "closed" });
    });
  });
});

describe("SlackChat.threadRootTs", () => {
  describe("a reply inside a thread", () => {
    let calls: Call[];
    let root: string;

    beforeEach(async () => {
      const slack = slackChat(() => ({ ok: true, messages: [{ ts: "1.5", thread_ts: "1.2" }] }));
      root = await slack.chat.threadRootTs("C1", "1.5");
      calls = slack.calls;
    });

    it("answers the timestamp of the thread root", () => {
      expect(root).toBe("1.2");
    });

    it("reads the message through conversations.replies", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/conversations.replies");
    });

    it("asks for one message at that timestamp", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", ts: "1.5", limit: "1" });
    });
  });

  describe("a message outside a thread", () => {
    it("answers its own timestamp", async () => {
      const { chat } = slackChat(() => ({ ok: true, messages: [{ ts: "1.2" }] }));
      expect(await chat.threadRootTs("C1", "1.2")).toBe("1.2");
    });
  });

  describe("a thread Slack cannot find", () => {
    it("throws the Slack error code", async () => {
      const { chat } = slackChat(() => ({ ok: false, error: "thread_not_found" }));
      await expect(chat.threadRootTs("C1", "1.5")).rejects.toThrow("thread_not_found");
    });
  });
});

describe("SlackChat.permalink", () => {
  describe("a message Slack knows", () => {
    const link = "https://acme.slack.com/archives/C1/p1700000001000100";
    let calls: Call[];
    let permalink: string;

    beforeEach(async () => {
      const slack = slackChat(() => ({ ok: true, permalink: link }));
      permalink = await slack.chat.permalink("C1", "1.2");
      calls = slack.calls;
    });

    it("answers the link Slack returned", () => {
      expect(permalink).toBe(link);
    });

    it("reads it through chat.getPermalink", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/chat.getPermalink");
    });

    it("sends the channel and the message timestamp", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", message_ts: "1.2" });
    });
  });

  describe("an answer without a permalink", () => {
    it("throws", async () => {
      const { chat } = slackChat(() => ({ ok: true }));
      await expect(chat.permalink("C1", "1.2")).rejects.toThrow("carries no permalink");
    });
  });
});

describe("SlackChat.user", () => {
  describe("a full member whose profile carries an email", () => {
    let calls: Call[];
    let user: ChatUser | null;

    beforeEach(async () => {
      const slack = slackChat(() => ({
        ok: true,
        user: { team_id: "T1", profile: { email: "ann@x.y" } },
      }));
      user = await slack.chat.user("U1");
      calls = slack.calls;
    });

    it("answers the email and the team they are a member of", () => {
      expect(user).toEqual({ id: "U1", email: "ann@x.y", member_of_team: "T1" });
    });

    it("reads the user through users.info", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/users.info");
    });

    it("sends the user id", () => {
      expect(calls[0]?.form).toEqual({ user: "U1" });
    });
  });

  describe("a profile that hides the email", () => {
    it("answers a null email", async () => {
      const { chat } = slackChat(() => ({ ok: true, user: { team_id: "T1", profile: {} } }));
      expect(await chat.user("U1")).toEqual({ id: "U1", email: null, member_of_team: "T1" });
    });
  });

  describe.each(["is_restricted", "is_ultra_restricted", "is_bot", "deleted"])(
    "a user Slack marks %s",
    (flag) => {
      it("is a full member of no team", async () => {
        const { chat } = slackChat(() => ({ ok: true, user: { team_id: "T1", [flag]: true } }));
        expect((await chat.user("U1"))?.member_of_team).toBeNull();
      });
    },
  );

  describe("a user Slack cannot find", () => {
    it("answers null", async () => {
      const { chat } = slackChat(() => ({ ok: false, error: "user_not_found" }));
      expect(await chat.user("U1")).toBeNull();
    });
  });

  describe("a fetch that throws", () => {
    it("answers null", async () => {
      const chat = new SlackChat("xoxb-test", {
        fetch: async () => {
          throw new Error("network down");
        },
      });
      expect(await chat.user("U1")).toBeNull();
    });
  });
});

function strictFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
  if (this !== undefined && this !== globalThis) {
    throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
  }
  if (args[1]?.redirect === "error") {
    throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
  }
  return Promise.resolve(Response.json({ ok: true, ts: "1.2" }));
}

async function redirecting(): Promise<Response> {
  return new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } });
}

describe("SlackChat fetch behaviour", () => {
  describe("the global fetch", () => {
    it("is called the way workerd requires", async () => {
      const original = globalThis.fetch;
      globalThis.fetch = strictFetch;
      try {
        const chat = new SlackChat("xoxb-test");
        await expect(chat.postThreadReply("C1", "1.0", "hello")).resolves.toEqual({ ts: "1.2" });
      } finally {
        globalThis.fetch = original;
      }
    });
  });

  describe("a Slack answer that redirects", () => {
    it("is refused instead of followed", async () => {
      const chat = new SlackChat("xoxb-test", { fetch: redirecting });
      await expect(chat.postThreadReply("C1", "1.0", "hello")).rejects.toThrow(
        "fetch refused a 302 redirect to https://elsewhere.test/",
      );
    });
  });
});
