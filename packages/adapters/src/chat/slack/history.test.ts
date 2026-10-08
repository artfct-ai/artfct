import { WebAPIHTTPError, WebAPIRateLimitedError } from "@slack/web-api";
import { beforeEach, describe, expect, it } from "bun:test";
import { fetchBody, fetchUrl } from "../../../test/fetch";
import { SlackChat } from "./chat";
import type { ChatPage } from "../types";

type Call = { url: string; form: Record<string, string> };

function slackChat(answer: (url: string) => unknown) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: fetchUrl(input),
      form: Object.fromEntries(new URLSearchParams(fetchBody(init))),
    });
    const answered = answer(fetchUrl(input));
    return answered instanceof Response ? answered : Response.json(answered);
  };
  return { chat: new SlackChat("xoxb-test", { fetch }), calls };
}

const HISTORY = {
  ok: true,
  messages: [
    { ts: "1757000200.000200", user: "U2", text: "<@U7> <@U8|claude> any idea?", reply_count: 3 },
    { ts: "1757000100.000100", bot_id: "B1", text: "HTTP 502" },
    { ts: "1757000050.000050", text: "" },
  ],
  has_more: true,
  response_metadata: { next_cursor: "older1" },
};

describe("SlackChat.channelHistory", () => {
  describe("a page Slack cut short", () => {
    let calls: Call[];
    let page: ChatPage;

    beforeEach(async () => {
      const slack = slackChat(() => HISTORY);
      page = await slack.chat.channelHistory("C1", { limit: 3 });
      calls = slack.calls;
    });

    it("reads through conversations.history", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/conversations.history");
    });

    it("sends the channel and the limit", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", limit: "3" });
    });

    it("returns the messages oldest first", () => {
      expect(page.messages.map((message) => message.ts)).toEqual([
        "1757000050.000050",
        "1757000100.000100",
        "1757000200.000200",
      ]);
    });

    it("reads an author as a user id, a bot id, or null", () => {
      expect(page.messages.map((message) => message.user)).toEqual([null, "B1", "U2"]);
    });

    it("carries the user ids each message tags", () => {
      expect(page.messages.map((message) => message.mentions)).toEqual([[], [], ["U7", "U8"]]);
    });

    it("carries the reply count of a thread root", () => {
      expect(page.messages[2]?.replyCount).toBe(3);
    });

    it("says Slack has more to give", () => {
      expect(page.hasMore).toBe(true);
    });

    it("carries the cursor of the next page", () => {
      expect(page.cursor).toBe("older1");
    });
  });

  describe("a read that walks back from a timestamp", () => {
    let chat: SlackChat;
    let calls: Call[];

    beforeEach(async () => {
      ({ chat, calls } = slackChat(() => ({ ok: true, messages: [] })));
      await chat.channelHistory("C1", { before: "1757000100.000100" });
    });

    it("sends the timestamp as latest", () => {
      expect(calls[0]?.form).toEqual({ channel: "C1", limit: "15", latest: "1757000100.000100" });
    });

    describe("then continues at a cursor", () => {
      beforeEach(async () => {
        await chat.channelHistory("C1", { before: "1757000100.000100", cursor: "older1" });
      });

      it("sends the cursor and drops the timestamp", () => {
        expect(calls[1]?.form).toEqual({ channel: "C1", limit: "15", cursor: "older1" });
      });
    });
  });

  describe("a limit outside what Slack accepts", () => {
    it("clamps a limit over the cap", async () => {
      const { chat, calls } = slackChat(() => ({ ok: true, messages: [] }));
      await chat.channelHistory("C1", { limit: 500 });
      expect(calls[0]?.form.limit).toBe("100");
    });

    it("raises a limit under one message", async () => {
      const { chat, calls } = slackChat(() => ({ ok: true, messages: [] }));
      await chat.channelHistory("C1", { limit: 0 });
      expect(calls[0]?.form.limit).toBe("1");
    });
  });
});

describe("SlackChat.threadReplies", () => {
  describe("a page of replies read at a cursor", () => {
    let calls: Call[];
    let page: ChatPage;

    beforeEach(async () => {
      const slack = slackChat(() => ({ ...HISTORY, response_metadata: {} }));
      page = await slack.chat.threadReplies("C1", "1757000050.000050", { limit: 3, cursor: "c2" });
      calls = slack.calls;
    });

    it("reads through conversations.replies", () => {
      expect(calls[0]?.url).toBe("https://slack.com/api/conversations.replies");
    });

    it("sends the channel, the root timestamp, the limit, and the cursor", () => {
      expect(calls[0]?.form).toEqual({
        channel: "C1",
        ts: "1757000050.000050",
        limit: "3",
        cursor: "c2",
      });
    });

    it("keeps the order Slack sent", () => {
      expect(page.messages[0]?.ts).toBe("1757000200.000200");
    });

    it("reports no cursor when Slack sends none", () => {
      expect(page.cursor).toBeNull();
    });
  });

  describe("an answer with no messages in it", () => {
    it("reads as an empty page with no more behind it", async () => {
      const { chat } = slackChat(() => ({ ok: true }));
      expect(await chat.threadReplies("C1", "1.1")).toEqual({
        messages: [],
        hasMore: false,
        cursor: null,
      });
    });
  });
});

describe("SlackChat history failures", () => {
  describe("a rate limit", () => {
    let calls: Call[];
    let error: unknown;

    beforeEach(async () => {
      const slack = slackChat(
        () => new Response("", { status: 429, headers: { "retry-after": "20" } }),
      );
      error = await slack.chat.channelHistory("C1").catch((caught) => caught);
      calls = slack.calls;
    });

    it("rejects with a rate limited error", () => {
      expect(error).toBeInstanceOf(WebAPIRateLimitedError);
    });

    it("carries the seconds to wait", () => {
      expect((error as WebAPIRateLimitedError).retryAfter).toBe(20);
    });

    it("makes one call instead of sleeping through the limit", () => {
      expect(calls).toHaveLength(1);
    });
  });

  describe("a body that is not Slack's own", () => {
    let chat: SlackChat;
    let error: unknown;

    beforeEach(async () => {
      chat = slackChat(() => new Response("<html>bad gateway</html>", { status: 502 })).chat;
      error = await chat.channelHistory("C1").catch((caught) => caught);
    });

    it("rejects with an HTTP error", () => {
      expect(error).toBeInstanceOf(WebAPIHTTPError);
    });

    it("describes the status for a reader", () => {
      expect(chat.describeFailure(error)).toBe("Slack answered HTTP 502 instead of a result.");
    });
  });
});
