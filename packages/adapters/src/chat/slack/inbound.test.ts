import { beforeEach, describe, expect, it } from "bun:test";
import type { InboundEvent } from "@artfct-ai/contracts/inbound";
import type { ChatUser } from "@artfct-ai/contracts/types";
import { fakeUserActor } from "../../../test/fake-actors";
import {
  appJoinedChannel,
  slackInbound,
  unwrapSlackLinks,
  type SlackEvent,
  type SlackEventCallback,
} from "./inbound";
import type { ChatInbound, ChatInboundContext, ChatLookup } from "../types";

const context: ChatInboundContext = {
  resolveActor: fakeUserActor(),
  chat: null,
  reaction: "white_check_mark",
};

type Seen = { userIds: string[]; roots: Array<{ channel: string; ts: string }> };

function fakeLookup(root: string | null): { chat: ChatLookup; seen: Seen } {
  const seen: Seen = { userIds: [], roots: [] };
  const chat: ChatLookup = {
    user: async (userId) => {
      seen.userIds.push(userId);
      return { id: userId, email: "dev@acme.test", member_of_team: "T1" };
    },
    threadRootTs: async (channel, ts) => {
      seen.roots.push({ channel, ts });
      if (root === null) throw new Error("thread_not_found");
      return root;
    },
  };
  return { chat, seen };
}

function callback(event: SlackEvent): SlackEventCallback {
  return {
    type: "event_callback",
    event_id: "Ev1",
    event,
    authorizations: [{ user_id: "UBOT" }],
  };
}

function normalize(event: SlackEvent, overrides: Partial<ChatInboundContext> = {}) {
  return slackInbound(callback(event), { ...context, ...overrides });
}

function threadReply(text: string): SlackEvent {
  return { type: "message", user: "U1", channel: "C1", ts: "1700.3", thread_ts: "1700.1", text };
}

function expectEvent(normalized: ChatInbound) {
  if ("ignore" in normalized) throw new Error(normalized.ignore);
  return normalized.event;
}

describe("a Slack Connect channel", () => {
  let lookup: ReturnType<typeof fakeLookup>;
  let normalized: ChatInbound;

  beforeEach(async () => {
    lookup = fakeLookup("1700.1");
    const mention: SlackEvent = {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1700.1",
      text: "<@UBOT> fix the test",
    };
    normalized = await slackInbound(
      { ...callback(mention), is_ext_shared_channel: true },
      { ...context, chat: lookup.chat },
    );
  });

  it("ignores a mention", () => {
    expect(normalized).toEqual({ ignore: "Slack Connect channel" });
  });

  it("looks nobody up", () => {
    expect(lookup.seen.userIds).toEqual([]);
  });
});

describe("slack mentions", () => {
  describe("a mention at the top of a channel", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalize({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1700.1",
          text: "<@UBOT> fix the test in <https://github.com/acme/app|acme/app>",
        }),
      );
    });

    it("takes its id from the callback", () => {
      expect(event.id).toBe("slack:Ev1");
    });

    it("starts a workflow", () => {
      expect(event.kind).toBe("start");
    });

    it("drops this app's own tag from the text", () => {
      expect(event.text).toBe("fix the test in https://github.com/acme/app");
    });

    it("reads the link out of the message", () => {
      expect(event.links).toEqual(["https://github.com/acme/app"]);
    });

    it("binds to the new thread", () => {
      expect(event.bindings).toEqual([{ source: "chat_thread", external_id: "C1:1700.1" }]);
    });

    it("replies in that thread", () => {
      expect(event.reply_to).toEqual({ source: "chat", channel: "C1", thread: "1700.1" });
    });

    it("acknowledges the message that mentioned it", () => {
      expect(event.acknowledge).toEqual({ message: "1700.1", user: "U1" });
    });

    it("names the sender as the actor", () => {
      expect(event.actor).toEqual({ person_id: "p_U1", email: null, display_name: null });
    });
  });

  describe("a mention inside an existing thread", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalize({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1700.2",
          thread_ts: "1700.1",
          text: "<@UBOT> looks good, go ahead",
        }),
      );
    });

    it("is a start", () => {
      expect(event.kind).toBe("start");
    });

    it("binds to the thread root", () => {
      expect(event.bindings).toEqual([{ source: "chat_thread", external_id: "C1:1700.1" }]);
    });

    it("acknowledges the mention message, not the root", () => {
      expect(event.acknowledge).toEqual({ message: "1700.2", user: "U1" });
    });
  });

  describe("a status question mentioned inside a thread", () => {
    it("only asks for status", async () => {
      const event = expectEvent(
        await normalize({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1700.2",
          thread_ts: "1700.1",
          text: "<@UBOT> status?",
        }),
      );
      expect(event.kind).toBe("status");
    });
  });

  describe("a status question mentioned at the top of a channel", () => {
    it("is a start", async () => {
      const event = expectEvent(
        await normalize({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1700.1",
          text: "<@UBOT> status?",
        }),
      );
      expect(event.kind).toBe("start");
    });
  });

  describe("a mention that also tags another agent", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalize({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1700.1",
          text: "<@UBOT> <@ULINEAR> link this thread to ENG-41",
        }),
      );
    });

    it("still starts a workflow", () => {
      expect(event.kind).toBe("start");
    });

    it("keeps the other agent visible, so the orchestrator can weigh who the work is for", () => {
      expect(event.text).toBe("@ULINEAR link this thread to ENG-41");
    });
  });

  describe("a mention with a chat lookup available", () => {
    let event: InboundEvent;
    let seen: Seen;

    beforeEach(async () => {
      const lookup = fakeLookup("1700.1");
      seen = lookup.seen;
      event = expectEvent(
        await normalize(
          { type: "app_mention", user: "U1", channel: "C1", ts: "1700.1", text: "hi" },
          { chat: lookup.chat },
        ),
      );
    });

    it("asks the lookup for the sender's profile", () => {
      expect(seen.userIds).toEqual(["U1"]);
    });

    it("puts the profile email on the actor", () => {
      expect(event.actor?.email).toBe("dev@acme.test");
    });
  });

  describe("the sender the resolver is asked about", () => {
    const mention: SlackEvent = {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1700.1",
      text: "hi",
    };
    let asked: ChatUser[];

    beforeEach(() => {
      asked = [];
    });

    async function resolveNobody(user: ChatUser) {
      asked.push(user);
      return null;
    }

    it("carries the team the lookup reports", async () => {
      await normalize(mention, { chat: fakeLookup("1700.1").chat, resolveActor: resolveNobody });
      expect(asked).toEqual([{ id: "U1", email: "dev@acme.test", member_of_team: "T1" }]);
    });

    it("is a member of no team without a lookup", async () => {
      await normalize(mention, { resolveActor: resolveNobody });
      expect(asked).toEqual([{ id: "U1", email: null, member_of_team: null }]);
    });
  });
});

describe("a slack sender who is not authorized", () => {
  const unauthorized = { resolveActor: fakeUserActor({ authorized: false }) };
  const ignored = { ignore: "sender is not authorized" };

  it("starts nothing with a mention", async () => {
    const mention: SlackEvent = {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1700.1",
      text: "<@UBOT> fix the test",
    };
    expect(await normalize(mention, unauthorized)).toEqual(ignored);
  });

  it("says nothing to a workflow with a thread reply", async () => {
    expect(await normalize(threadReply("approved, ship it"), unauthorized)).toEqual(ignored);
  });

  it("says nothing to a workflow with the reaction", async () => {
    const reaction: SlackEvent = {
      type: "reaction_added",
      user: "U1",
      reaction: "white_check_mark",
      item: { type: "message", channel: "C1", ts: "1700.3" },
    };
    expect(await normalize(reaction, unauthorized)).toEqual(ignored);
  });
});

describe("slack thread replies", () => {
  describe("a reply from a person that tags nobody", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(await normalize(threadReply("also update the docs")));
    });

    it("becomes a prompt", () => {
      expect(event.kind).toBe("prompt");
    });

    it("carries the reply text", () => {
      expect(event.text).toBe("also update the docs");
    });

    it("acknowledges the reply", () => {
      expect(event.acknowledge).toEqual({ message: "1700.3", user: "U1" });
    });
  });

  describe("a reply that tags this app", () => {
    const mention = { ignore: "mention, delivered as app_mention" };

    it("leaves a bare tag to the app_mention event", async () => {
      expect(await normalize(threadReply("<@UBOT> also update the docs"))).toEqual(mention);
    });

    it("leaves a labelled tag to the app_mention event", async () => {
      expect(await normalize(threadReply("<@UBOT|artfct> also update the docs"))).toEqual(mention);
    });

    it("leaves a tag alongside another agent to the app_mention event", async () => {
      expect(await normalize(threadReply("<@UBOT> <@ULINEAR> link this thread to ENG-41"))).toEqual(
        mention,
      );
    });
  });

  describe("a reply aimed at somebody else", () => {
    const somebodyElse = { ignore: "addressed to somebody else" };

    it("ignores a reply aimed at another agent", async () => {
      expect(
        await normalize(threadReply("<@ULINEAR> can you link this thread to ENG-41?")),
      ).toEqual(somebodyElse);
    });

    it("ignores a reply aimed at another person", async () => {
      expect(await normalize(threadReply("<@U2> can you take a look?"))).toEqual(somebodyElse);
    });

    it("ignores a reply aimed at a user group", async () => {
      expect(await normalize(threadReply("<!subteam^S1|@eng> any idea what broke?"))).toEqual(
        somebodyElse,
      );
    });
  });

  describe("a reply that answers this app and names a colleague", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(
        await normalize(threadReply("B, and <@U2> should sanity check the migration")),
      );
    });

    it("is still a prompt", () => {
      expect(event.kind).toBe("prompt");
    });

    it("keeps the colleague as a readable name", () => {
      expect(event.text).toBe("B, and @U2 should sanity check the migration");
    });
  });

  describe("a message this app cannot answer", () => {
    it("ignores a reply the bot itself wrote", async () => {
      const fromBot = await normalize({
        type: "message",
        user: "UBOT",
        channel: "C1",
        ts: "1",
        thread_ts: "0",
        text: "x",
      });
      expect("ignore" in fromBot).toBe(true);
    });

    it("ignores a top-level message, which starts no thread", async () => {
      const topLevel = await normalize({
        type: "message",
        user: "U1",
        channel: "C1",
        ts: "1",
        text: "x",
      });
      expect("ignore" in topLevel).toBe(true);
    });
  });
});

describe("slack reactions", () => {
  const reaction: SlackEvent = {
    type: "reaction_added",
    user: "U2",
    reaction: "white_check_mark",
    item: { type: "message", channel: "C1", ts: "1700.5" },
  };

  describe("the one reaction this app watches, with no chat lookup", () => {
    let event: InboundEvent;

    beforeEach(async () => {
      event = expectEvent(await normalize(reaction));
    });

    it("becomes a prompt", () => {
      expect(event.kind).toBe("prompt");
    });

    it("reads as a short reply", () => {
      expect(event.text).toBe("reacted with :white_check_mark:");
    });

    it("binds to the reacted message", () => {
      expect(event.bindings).toEqual([{ source: "chat_thread", external_id: "C1:1700.5" }]);
    });

    it("acknowledges nothing", () => {
      expect(event.acknowledge).toBeUndefined();
    });
  });

  describe("a reaction on a reply inside a thread", () => {
    let event: InboundEvent;
    let seen: Seen;

    beforeEach(async () => {
      const lookup = fakeLookup("1700.1");
      seen = lookup.seen;
      event = expectEvent(await normalize(reaction, { chat: lookup.chat }));
    });

    it("looks the reacted message up", () => {
      expect(seen.roots).toEqual([{ channel: "C1", ts: "1700.5" }]);
    });

    it("asks the lookup for the reacting user's profile", () => {
      expect(seen.userIds).toEqual(["U2"]);
    });

    it("binds to the thread root", () => {
      expect(event.bindings).toEqual([{ source: "chat_thread", external_id: "C1:1700.1" }]);
    });

    it("replies in the thread root", () => {
      expect(event.reply_to).toEqual({ source: "chat", channel: "C1", thread: "1700.1" });
    });

    it("puts the profile email on the actor", () => {
      expect(event.actor?.email).toBe("dev@acme.test");
    });
  });

  describe("a reaction whose root lookup fails", () => {
    it("falls back to the reacted message", async () => {
      const { chat } = fakeLookup(null);
      const event = expectEvent(await normalize(reaction, { chat }));
      expect(event.bindings).toEqual([{ source: "chat_thread", external_id: "C1:1700.5" }]);
    });
  });

  describe("a reaction this app does not watch", () => {
    it("is ignored", async () => {
      const normalized = await normalize({ ...reaction, reaction: "eyes" });
      expect("ignore" in normalized).toBe(true);
    });
  });
});

function joined(user: string): SlackEvent {
  return { type: "member_joined_channel", user, channel: "C1" };
}

describe("slack channel joins", () => {
  describe("this app joining a channel", () => {
    it("names the channel", () => {
      expect(appJoinedChannel(callback(joined("UBOT")))).toBe("C1");
    });
  });

  describe("this app joining a Slack Connect channel", () => {
    it("names no channel", () => {
      const shared = { ...callback(joined("UBOT")), is_ext_shared_channel: true };
      expect(appJoinedChannel(shared)).toBeNull();
    });
  });

  describe("another member joining the same channel", () => {
    it("names no channel", () => {
      expect(appJoinedChannel(callback(joined("U1")))).toBeNull();
    });

    it("is ignored by the mapper", async () => {
      const normalized = await normalize(joined("U1"));
      expect("ignore" in normalized).toBe(true);
    });
  });

  describe("a mention of this app", () => {
    it("names no channel", () => {
      const mention: SlackEvent = {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        ts: "1700.1",
        text: "<@UBOT> ship it",
      };
      expect(appJoinedChannel(callback(mention))).toBeNull();
    });
  });

  describe("a join on a callback that names no authorization", () => {
    it("names no channel", () => {
      const bare: SlackEventCallback = {
        type: "event_callback",
        event_id: "Ev1",
        event: joined("UBOT"),
      };
      expect(appJoinedChannel(bare)).toBeNull();
    });
  });
});

describe("slack links", () => {
  describe("a link Slack wrapped with a label", () => {
    it("unwraps it to the bare url", () => {
      expect(unwrapSlackLinks("see <https://github.com/a/b|a/b> now")).toBe(
        "see https://github.com/a/b now",
      );
    });
  });
});
