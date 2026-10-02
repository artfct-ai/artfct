import { FakeChat, type ChatMethod } from "@artfct-ai/adapters/test/fake-chat";
import { Notifier } from "../src/notify/notifier";
import type { FakeRuntime } from "./fake-runtime";

/** A point a chat call stops at until the test opens it. */
export type Gate = { reached: Promise<void>; open: () => void; hold: () => Promise<void> };

/** A closed gate. `hold` waits on it, `reached` resolves once something waits. */
export function gate(): Gate {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    open: () => release(),
    hold: async () => {
      arrive();
      await opened;
    },
  };
}

/** Error texts each method throws on its next calls, in order. */
export type ChatFailures = Partial<Record<ChatMethod, string[]>>;

/** Gates each method stops at once the chat recorded the call. */
export type ChatHolds = Partial<Record<ChatMethod, Gate>>;

/** A fake chat whose board calls fail or stop where a test scripts them to. */
export class ScriptedChat extends FakeChat {
  constructor(
    private readonly failures: ChatFailures = {},
    private readonly holds: ChatHolds = {},
  ) {
    super();
  }

  override async postThreadMessage(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<{ ts: string }> {
    const posted = await super.postThreadMessage(channel, threadTs, text);
    await this.holdAndFail("postThreadMessage");
    return posted;
  }

  override async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await super.updateMessage(channel, ts, text);
    await this.holdAndFail("updateMessage");
  }

  override async deleteMessage(channel: string, ts: string): Promise<void> {
    await super.deleteMessage(channel, ts);
    await this.holdAndFail("deleteMessage");
  }

  override async permalink(channel: string, ts: string): Promise<string> {
    const link = await super.permalink(channel, ts);
    await this.holdAndFail("permalink");
    return link;
  }

  private async holdAndFail(method: ChatMethod): Promise<void> {
    await this.holds[method]?.hold();
    const error = this.failures[method]?.shift();
    if (error) throw new Error(error);
  }
}

/** The one chat thread `attachChat` replies on. */
export const BOARD_THREAD = { source: "chat", channel: "C1", thread: "1.0" } as const;

/** Reply on `BOARD_THREAD` through `chat`, so the runtime's boards go there. */
export function attachChat(workflow: FakeRuntime, chat: FakeChat): void {
  workflow.notifier = new Notifier(
    { tracker: async () => null, chat, docs: async () => null },
    (entry) => workflow.store.writeOutbox(entry),
  );
  workflow.state.reply_targets = [BOARD_THREAD];
}
