import type { SessionOptions, SessionStatus } from "@artfct-ai/adapters/chat/types";
import { FakeChat, type ChatMethod } from "@artfct-ai/adapters/test/fake-chat";
import type { Chat } from "@artfct-ai/adapters/chat/types";
import type { Documents } from "@artfct-ai/adapters/docs/types";
import type { Tracker } from "@artfct-ai/adapters/tracker/types";
import { Notifier, type NotifierOptions, type OutboxEntry } from "../src/notify/notifier";

/** A chat whose listed methods record the call and then fail. */
class BrokenChat extends FakeChat {
  constructor(private readonly broken: ChatMethod[]) {
    super();
  }

  override async postThreadReply(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts: string }> {
    const posted = await super.postThreadReply(channel, threadTs, text);
    this.failIfBroken("postThreadReply");
    return posted;
  }

  override async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await super.updateMessage(channel, ts, text);
    this.failIfBroken("updateMessage");
  }

  override async addReaction(channel: string, ts: string, name: string): Promise<void> {
    await super.addReaction(channel, ts, name);
    this.failIfBroken("addReaction");
  }

  override async setSessionStatus(
    channel: string,
    threadTs: string,
    status: SessionStatus,
    options?: SessionOptions,
  ): Promise<void> {
    await super.setSessionStatus(channel, threadTs, status, options);
    this.failIfBroken("setSessionStatus");
  }

  private failIfBroken(method: ChatMethod): void {
    if (this.broken.includes(method)) throw new Error(`slack ${method}: msg_too_long`);
  }
}

/** A recording chat. Listed methods fail after recording. */
export function fakeSlack(failing: ChatMethod[] = []): FakeChat {
  return failing.length ? new BrokenChat(failing) : new FakeChat();
}

/** The clients a test notifier posts through. A channel left out has no credentials. */
export type TestChannels = {
  tracker?: Tracker | null;
  chat?: Chat | null;
  docs?: Documents | null;
};

/** A notifier over the named clients, writing every outbox entry into `outbox`. */
export function testNotifier(
  outbox: OutboxEntry[],
  clients: TestChannels = {},
  options: NotifierOptions = {},
): Notifier {
  const { tracker = null, chat = null, docs = null } = clients;
  return new Notifier(
    { tracker: async () => tracker, chat, docs: async () => docs },
    (entry) => outbox.push(entry),
    options,
  );
}
