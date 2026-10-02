import { FakeChat, type ChatAnswers } from "@artfct-ai/adapters/test/fake-chat";
import type { ChatMessage, ChatPage } from "@artfct-ai/adapters/chat/types";
import { describe, expect, it } from "bun:test";
import { freshRuntime } from "../../../test/fresh-runtime";
import { type FakeRuntime } from "../../../test/fake-runtime";
import { scenario } from "../../../test/scenario";
import { toolText } from "../../../test/tool-result";
import { historyTools, keepNewestWithinBudget } from "./history";

const call = { toolCallId: "call-1", messages: [], context: {} };

const REQUEST_THREAD = "1757000400.000400";
const THREAD_TS = "1757000200.000200";

function message(patch: Partial<ChatMessage> & { ts: string }): ChatMessage {
  return { user: "U1", text: "", replyCount: 0, ...patch };
}

function page(messages: ChatMessage[], patch: Partial<ChatPage> = {}): ChatPage {
  return { messages, hasMore: false, cursor: null, ...patch };
}

function longMessages(): ChatMessage[] {
  return Array.from({ length: 40 }, (_unused, index) =>
    message({ ts: `17570000${String(index + 1).padStart(2, "0")}.000000`, text: "y".repeat(1400) }),
  );
}

const CHANNEL = page([
  message({ ts: "1757000100.000100", text: "publication id michaeljburry: HTTP 502" }),
  message({ ts: THREAD_TS, user: "U2", text: "any idea?", replyCount: 3 }),
]);

const THREAD = page([
  message({ ts: THREAD_TS, user: "U2", text: "any idea?", replyCount: 3 }),
  message({ ts: "1757000300.000300", user: "U3", text: "the sync retries forever" }),
]);

function slackChat(workflow: FakeRuntime, answers: ChatAnswers): FakeChat {
  workflow.patchState({
    origin: { source: "chat", channel: "C1", thread: REQUEST_THREAD },
    reply_targets: [{ source: "chat", channel: "C1", thread: REQUEST_THREAD }],
  });
  const chat = new FakeChat(answers);
  workflow.chatInstance = chat;
  return chat;
}

describe("read_channel", () => {
  describe("the channel the request came from", () => {
    let chat: FakeChat;
    let lines: string[];
    const read = scenario(freshRuntime, async (workflow) => {
      chat = slackChat(workflow, { history: CHANNEL });
      const { read_channel } = historyTools(workflow);
      lines = toolText(await read_channel.execute({ limit: 30 }, call)).split("\n");
    });

    it("lists every message with its ts, time, author, and thread", () =>
      read(() => {
        expect(lines).toEqual([
          "2 message(s) from channel C1, oldest first.",
          `The thread this request came from is thread_ts=${REQUEST_THREAD}.`,
          "- ts=1757000100.000100 at=2025-09-04T15:35:00.000Z from=U1: publication id michaeljburry: HTTP 502",
          "- ts=1757000200.000200 at=2025-09-04T15:36:40.000Z from=U2 thread=1757000200.000200 replies=3: any idea?",
        ]);
      }));

    it("asks Slack for the channel of the request", () =>
      read(() => {
        expect(chat.argsOf("channelHistory")).toEqual([["C1", { limit: 30 }]]);
      }));
  });

  describe("a read that names a thread_ts", () => {
    let chat: FakeChat;
    let text: string;
    const read = scenario(freshRuntime, async (workflow) => {
      chat = slackChat(workflow, { replies: THREAD });
      const { read_channel } = historyTools(workflow);
      text = toolText(await read_channel.execute({ limit: 5, thread_ts: THREAD_TS }, call));
    });

    it("names the thread and how many messages it holds", () =>
      read(() => {
        expect(text).toContain(`2 message(s) from thread ${THREAD_TS}, oldest first.`);
      }));

    it("holds the replies of that thread", () =>
      read(() => {
        expect(text).toContain("the sync retries forever");
      }));

    it("leaves out the line about the request thread", () =>
      read(() => {
        expect(text).not.toContain("The thread this request came from");
      }));

    it("asks Slack for the replies of that thread", () =>
      read(() => {
        expect(chat.argsOf("threadReplies")).toEqual([["C1", THREAD_TS, { limit: 5 }]]);
      }));
  });

  describe("a read paged further back with before_ts", () => {
    let chat: FakeChat;
    let text: string;
    const read = scenario(freshRuntime, async (workflow) => {
      chat = slackChat(workflow, {});
      const { read_channel } = historyTools(workflow);
      text = toolText(
        await read_channel.execute({ limit: 10, before_ts: "1757000100.000100" }, call),
      );
    });

    it("says the page is empty and names the request thread", () =>
      read(() => {
        expect(text).toBe(
          `No messages in channel C1.\nThe thread this request came from is thread_ts=${REQUEST_THREAD}.`,
        );
      }));

    it("passes the ts to Slack as the page to read before", () =>
      read(() => {
        expect(chat.argsOf("channelHistory")).toEqual([
          ["C1", { limit: 10, before: "1757000100.000100" }],
        ]);
      }));
  });

  describe("a thread Slack cut short", () => {
    let chat: FakeChat;
    let text: string;
    const read = scenario(freshRuntime, async (workflow) => {
      chat = slackChat(workflow, { replies: { ...THREAD, hasMore: true, cursor: "more1" } });
      const { read_channel } = historyTools(workflow);
      text = toolText(await read_channel.execute({ limit: 2, thread_ts: THREAD_TS }, call));
    });

    it("names the cursor that reaches the rest of the replies", () =>
      read(() => {
        expect(text).toContain("This thread has more replies. Read them with cursor=more1.");
      }));

    it("offers no before_ts, which a thread read cannot use", () =>
      read(() => {
        expect(text).not.toContain("before_ts");
      }));

    describe("and read again from that cursor", () => {
      const continued = scenario(read, async (workflow) => {
        const { read_channel } = historyTools(workflow);
        await read_channel.execute({ limit: 2, thread_ts: THREAD_TS, cursor: "more1" }, call);
      });

      it("passes the cursor to Slack", () =>
        continued(() => {
          expect(chat.argsOf("threadReplies")[1]).toEqual([
            "C1",
            THREAD_TS,
            { limit: 2, cursor: "more1" },
          ]);
        }));
    });
  });

  describe("a channel page Slack cut short", () => {
    it("names the cursor that reaches the older messages", () =>
      freshRuntime(async (workflow) => {
        slackChat(workflow, { history: { ...CHANNEL, hasMore: true, cursor: "older1" } });
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 2 }, call))).toContain(
          "The chat host has messages older than this page. Read them with cursor=older1.",
        );
      }));

    it("says the chat host named no cursor when it gave none", () =>
      freshRuntime(async (workflow) => {
        slackChat(workflow, { history: { ...CHANNEL, hasMore: true } });
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 2 }, call))).toContain(
          "The chat host has messages older than this page, and the chat host named no cursor for them.",
        );
      }));
  });

  describe("a channel page too long for the budget", () => {
    let lines: string[];
    let text: string;
    let named: string | undefined;
    let advice: number;
    const read = scenario(freshRuntime, async (workflow) => {
      slackChat(workflow, { history: page(longMessages()) });
      const { read_channel } = historyTools(workflow);
      text = toolText(await read_channel.execute({ limit: 20 }, call));
      lines = text.split("\n");
      named = /before_ts=([\d.]+)\./.exec(text)?.[1];
      advice = lines.findIndex((line) => line.includes("left out to stay in budget"));
    });

    it("says how many of the oldest messages it left out", () =>
      read(() => {
        expect(text).toContain("message(s) left out to stay in budget, the oldest of this page.");
      }));

    it("names a before_ts that reaches them", () =>
      read(() => {
        expect(named).toBeDefined();
      }));

    it("names the ts of the oldest message it did show", () =>
      read(() => {
        const firstShown = lines.find((line) => line.startsWith("- ts="));
        expect(firstShown).toContain(`ts=${named} `);
      }));

    it("puts the advice after the last message", () =>
      read(() => {
        expect(advice).toBeGreaterThan(lines.findLastIndex((line) => line.startsWith("- ts=")));
      }));

    it("puts the advice on the last line", () =>
      read(() => {
        expect(advice).toBe(lines.length - 1);
      }));
  });

  describe("a thread page too long for the budget", () => {
    let first: string;
    const read = scenario(freshRuntime, async (workflow) => {
      slackChat(workflow, { replies: page(longMessages()) });
      const { read_channel } = historyTools(workflow);
      first = toolText(await read_channel.execute({ limit: 20, thread_ts: "1.1" }, call));
    });

    it("asks for a smaller limit", () =>
      read(() => {
        expect(first).toContain(
          "message(s) left out to stay in budget, the earliest of this page. Read them with a smaller limit.",
        );
      }));

    it("offers no before_ts", () =>
      read(() => {
        expect(first).not.toContain("before_ts=");
      }));

    describe("and read from a cursor", () => {
      let paged: string;
      const fromCursor = scenario(read, async (workflow) => {
        const { read_channel } = historyTools(workflow);
        paged = toolText(
          await read_channel.execute({ limit: 20, thread_ts: "1.1", cursor: "page2" }, call),
        );
      });

      it("asks for the same cursor with a smaller limit", () =>
        fromCursor(() => {
          expect(paged).toContain(
            "the earliest of this page. Read them with cursor=page2 and a smaller limit.",
          );
        }));
    });
  });

  describe("a channel page that both drops for budget and has more", () => {
    let text: string;
    const read = scenario(freshRuntime, async (workflow) => {
      slackChat(workflow, { history: page(longMessages(), { hasMore: true, cursor: "older1" }) });
      const { read_channel } = historyTools(workflow);
      text = toolText(await read_channel.execute({ limit: 20 }, call));
    });

    it("names the before_ts of the dropped messages", () =>
      read(() => {
        expect(text).toContain("the oldest of this page. Read them with before_ts=");
      }));

    it("names no cursor", () =>
      read(() => {
        expect(text).not.toContain("cursor=older1");
      }));

    it("says nothing about the older messages Slack holds", () =>
      read(() => {
        expect(text).not.toContain("The chat host has messages older than this page");
      }));
  });

  describe("a chat client whose reads fail", () => {
    const failing = scenario(freshRuntime, (workflow) => {
      slackChat(workflow, { failing: true });
    });

    it("returns the channel failure as a sentence", () =>
      failing(async (workflow) => {
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 30 }, call))).toBe(
          "Could not read channel C1: channelHistory: boom",
        );
      }));

    it("returns the thread failure as a sentence", () =>
      failing(async (workflow) => {
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 30, thread_ts: "1.1" }, call))).toBe(
          "Could not read thread 1.1: threadReplies: boom",
        );
      }));
  });

  describe("a workflow with no chat channel", () => {
    it("says the request came from somewhere else", () =>
      freshRuntime(async (workflow) => {
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 30 }, call))).toBe(
          "This workflow has no chat channel. The request came from somewhere else.",
        );
      }));
  });

  describe("a Slack reply target with no Slack client", () => {
    it("says chat is not configured", () =>
      freshRuntime(async (workflow) => {
        workflow.patchState({
          reply_targets: [{ source: "chat", channel: "C1", thread: "1.1" }],
        });
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 30 }, call))).toBe(
          "Chat is not configured.",
        );
      }));
  });

  describe("a request that came in from the tracker with a chat reply target", () => {
    it("reads the channel of the reply target", () =>
      freshRuntime(async (workflow) => {
        const chat = slackChat(workflow, { history: CHANNEL });
        workflow.patchState({ origin: { source: "tracker", session_id: "s1", issue_id: "i1" } });
        const { read_channel } = historyTools(workflow);
        await read_channel.execute({ limit: 30 }, call);
        expect(chat.argsOf("channelHistory")[0]?.[0]).toBe("C1");
      }));
  });

  describe("a message that would fill the transcript", () => {
    let text: string;
    const read = scenario(freshRuntime, async (workflow) => {
      slackChat(workflow, {
        history: page([message({ ts: "1757000100.000100", text: "x".repeat(4000) })]),
      });
      const { read_channel } = historyTools(workflow);
      text = toolText(await read_channel.execute({ limit: 1 }, call));
    });

    it("marks where it cut the message", () =>
      read(() => {
        expect(text).toContain("... [message cut at 1500 characters]");
      }));

    it("keeps the read short", () =>
      read(() => {
        expect(text.length).toBeLessThan(1800);
      }));
  });

  describe("a message without a sender or a usable timestamp", () => {
    it("reads it with unknown in place of both", () =>
      freshRuntime(async (workflow) => {
        slackChat(workflow, {
          history: page([message({ ts: "not-a-ts", user: null, text: "hello" })]),
        });
        const { read_channel } = historyTools(workflow);
        expect(toolText(await read_channel.execute({ limit: 1 }, call))).toContain(
          "ts=not-a-ts at=unknown from=unknown: hello",
        );
      }));
  });
});

describe("keepNewestWithinBudget", () => {
  describe("lines that fit the budget", () => {
    it("keeps every one of them", () => {
      expect(keepNewestWithinBudget(["a", "b"])).toEqual({ kept: ["a", "b"], dropped: 0 });
    });
  });

  describe("more lines than the budget holds", () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => `${index}`.padEnd(1000, "x"));

    it("keeps the newest lines and drops the oldest first", () => {
      const { kept } = keepNewestWithinBudget(lines);
      expect(kept).toHaveLength(39);
      expect(kept[0]).toBe(lines[21]);
      expect(kept.at(-1)).toBe(lines.at(-1));
    });

    it("counts the lines it dropped", () => {
      expect(keepNewestWithinBudget(lines).dropped).toBe(21);
    });
  });
});
