import { describe, expect, it } from "bun:test";
import { FakeChat } from "@artfct-ai/adapters/test/fake-chat";
import type { z } from "zod";
import type { ChatMessageRef } from "../../workflow/store/state";
import { acceptingD1 } from "../../../test/accepting-d1";
import { freshRuntime } from "../../../test/fresh-runtime";
import { createFakeWorkflow, FakeRuntime, seedTask } from "../../../test/fake-runtime";
import { openMemoryDb } from "../../../test/memory-db";
import { scenario, type Scenario } from "../../../test/scenario";
import { testEnv } from "../../../test/test-env";
import { toolText } from "../../../test/tool-result";
import {
  acknowledgeRevisionRequest,
  channelTools,
  REVISION_ACKNOWLEDGEMENT_TEXT,
  THUMBS_UP,
  type Acknowledgement,
} from "./channel";

const call = { toolCallId: "call-1", messages: [], context: {} };

const MESSAGE: ChatMessageRef = { channel: "C1", message: "1757000001.000100" };
const LATER_MESSAGE: ChatMessageRef = { channel: "C1", message: "1757000002.000200" };

function takeChatMessages(workflow: FakeRuntime, written: ChatMessageRef[]): void {
  for (const chatMessage of written) {
    workflow.transcript.enqueue("fix it", "message", { chat_message: chatMessage });
  }
  workflow.transcript.takeInbox();
}

function firstReplySchema(workflow: FakeRuntime): z.ZodType {
  return channelTools(workflow, workflow.transcript.answering()).acknowledge
    .inputSchema as z.ZodType;
}

const routedRuntime: Scenario<FakeRuntime> = async (run) => {
  await run(new FakeRuntime(openMemoryDb(), { ...testEnv(), DB: acceptingD1() }));
};

const unstartedRoutedRuntime: Scenario<FakeRuntime> = async (run) => {
  const env = { ...testEnv(), DB: acceptingD1() };
  const workflow = new FakeRuntime(openMemoryDb(), env, "uncreated");
  createFakeWorkflow(workflow);
  await run(workflow);
};

describe("acknowledgeRevisionRequest", () => {
  describe("on chat messages that wait for the thumbs-up", () => {
    let chat: FakeChat;
    const acknowledgement: Acknowledgement = { acknowledged: false };
    const replied = scenario(freshRuntime, async (workflow) => {
      chat = new FakeChat();
      workflow.chatInstance = chat;
      takeChatMessages(workflow, [MESSAGE]);
      await acknowledgeRevisionRequest(workflow, workflow.transcript.answering(), acknowledgement);
    });

    it("puts the thumbs-up on them and posts nothing", () =>
      replied((workflow) => {
        expect(chat.argsOf("addReaction")).toEqual([["C1", "1757000001.000100", THUMBS_UP]]);
        expect(workflow.posted).toEqual([]);
      }));

    it("marks the turn acknowledged", () =>
      replied(() => {
        expect(acknowledgement.acknowledged).toBe(true);
      }));
  });

  describe("without a chat message to react to", () => {
    let refusal = "";
    const replied = scenario(freshRuntime, async (workflow) => {
      const acknowledgement: Acknowledgement = { acknowledged: false };
      const answering = workflow.transcript.answering();
      await acknowledgeRevisionRequest(workflow, answering, acknowledgement);
      try {
        await channelTools(workflow, answering, acknowledgement).acknowledge.execute(
          { reply: { kind: "text", text: "Got it." } },
          call,
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    });

    it("posts one line", () =>
      replied((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: REVISION_ACKNOWLEDGEMENT_TEXT }]);
      }));

    it("leaves the model's acknowledge nothing to send", () =>
      replied(() => {
        expect(refusal).toMatch(/^Already acknowledged/);
      }));
  });
});

describe("channel tools", () => {
  describe("acknowledge", () => {
    describe("with a line", () => {
      let result: string;
      const acknowledged = scenario(freshRuntime, async (workflow) => {
        result = toolText(
          await channelTools(workflow, workflow.transcript.answering()).acknowledge.execute(
            { reply: { kind: "text", text: "Working on it." } },
            call,
          ),
        );
      });

      it("answers that the line went out", () =>
        acknowledged(() => {
          expect(result).toBe("Acknowledged.");
        }));

      it("sends an info event to the channels", () =>
        acknowledged((workflow) => {
          expect(workflow.posted).toEqual([{ type: "info", text: "Working on it." }]);
        }));

      it("keeps the workflow running", () =>
        acknowledged((workflow) => {
          expect(workflow.store.requireWorkflowRow().status).toBe("running");
        }));
    });

    describe("called twice in one turn", () => {
      let refusal = "";
      const twice = scenario(freshRuntime, async (workflow) => {
        const tools = channelTools(workflow, workflow.transcript.answering());
        await tools.acknowledge.execute({ reply: { kind: "text", text: "Got it." } }, call);
        try {
          await tools.acknowledge.execute(
            { reply: { kind: "text", text: "Still working." } },
            call,
          );
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
      });

      it("refuses the second line", () =>
        twice(() => {
          expect(refusal).toMatch(/^Already acknowledged/);
        }));

      it("posts only the first", () =>
        twice((workflow) => {
          expect(workflow.posted).toEqual([{ type: "info", text: "Got it." }]);
        }));
    });

    describe("with a reaction on the chat messages people wrote", () => {
      let chat: FakeChat;
      let result: string;
      const reacted = scenario(freshRuntime, async (workflow) => {
        chat = new FakeChat();
        workflow.chatInstance = chat;
        takeChatMessages(workflow, [MESSAGE, LATER_MESSAGE]);
        const tools = channelTools(workflow, workflow.transcript.answering());
        result = toolText(await tools.acknowledge.execute({ reply: { kind: "reaction" } }, call));
      });

      it("answers that the reaction went out", () =>
        reacted(() => {
          expect(result).toBe("Reacted with a thumbs-up.");
        }));

      it("puts the thumbs-up on every message", () =>
        reacted(() => {
          expect(chat.argsOf("addReaction")).toEqual([
            ["C1", "1757000001.000100", THUMBS_UP],
            ["C1", "1757000002.000200", THUMBS_UP],
          ]);
        }));

      it("posts nothing", () =>
        reacted((workflow) => {
          expect(workflow.posted).toEqual([]);
        }));

      it("leaves the turn no message to react to again", () =>
        reacted((workflow) => {
          expect(workflow.transcript.awaitingThumbsUp()).toEqual([]);
          expect(
            firstReplySchema(workflow).safeParse({ reply: { kind: "reaction" } }).success,
          ).toBe(false);
        }));
    });

    describe("with a reaction the chat refuses", () => {
      let refusal = "";
      let line = "";
      const refused = scenario(freshRuntime, async (workflow) => {
        workflow.chatInstance = new FakeChat({ failing: true });
        takeChatMessages(workflow, [MESSAGE]);
        const tools = channelTools(workflow, workflow.transcript.answering());
        try {
          await tools.acknowledge.execute({ reply: { kind: "reaction" } }, call);
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
        line = toolText(
          await tools.acknowledge.execute({ reply: { kind: "text", text: "On it." } }, call),
        );
      });

      it("fails the call", () =>
        refused(() => {
          expect(refusal).not.toBe("");
        }));

      it("keeps the message for a later reaction", () =>
        refused((workflow) => {
          expect(workflow.transcript.awaitingThumbsUp().map((row) => row.chat_message)).toEqual([
            MESSAGE,
          ]);
        }));

      it("still takes a line", () =>
        refused((workflow) => {
          expect(line).toBe("Acknowledged.");
          expect(workflow.posted).toEqual([{ type: "info", text: "On it." }]);
        }));
    });

    describe("in a turn without a chat message", () => {
      it("does not offer the reaction", () =>
        freshRuntime(async (workflow) => {
          expect(
            firstReplySchema(workflow).safeParse({ reply: { kind: "reaction" } }).success,
          ).toBe(false);
        }));

      it("offers the line", () =>
        freshRuntime(async (workflow) => {
          const line = { reply: { kind: "text", text: "On it." } };
          expect(firstReplySchema(workflow).safeParse(line).success).toBe(true);
        }));
    });
  });

  describe("tell", () => {
    let result: string;
    const told = scenario(freshRuntime, async (workflow) => {
      result = toolText(
        await channelTools(workflow, workflow.transcript.answering()).tell.execute(
          { text: "The harness cannot push." },
          call,
        ),
      );
    });

    it("answers that the line went out", () =>
      told(() => {
        expect(result).toBe("Told.");
      }));

    it("sends an info event to the channels", () =>
      told((workflow) => {
        expect(workflow.posted).toEqual([{ type: "info", text: "The harness cannot push." }]);
      }));
  });

  describe("ask", () => {
    describe("while no task runs", () => {
      let result: string;
      const asked = scenario(routedRuntime, async (workflow) => {
        result = toolText(
          await channelTools(workflow, workflow.transcript.answering()).ask.execute(
            { text: "Which repo?" },
            call,
          ),
        );
      });

      it("answers that the question went out", () =>
        asked(() => {
          expect(result).toMatch(/^Asked/);
        }));

      it("marks the workflow as waiting for input", () =>
        asked((workflow) => {
          expect(workflow.store.requireWorkflowRow().status).toBe("waiting_input");
        }));

      it("sends a question event to the channels", () =>
        asked((workflow) => {
          expect(workflow.posted).toEqual([{ type: "question", text: "Which repo?" }]);
        }));
    });

    describe("while the workflow has not started", () => {
      const asked = scenario(unstartedRoutedRuntime, async (workflow) => {
        await channelTools(workflow, workflow.transcript.answering()).ask.execute(
          { text: "Which repo?" },
          call,
        );
      });

      it("keeps the workflow new", () =>
        asked((workflow) => {
          expect(workflow.store.requireWorkflowRow().status).toBe("new");
        }));
    });

    describe("while a task is active", () => {
      const asked = scenario(freshRuntime, async (workflow) => {
        seedTask(workflow);
        await channelTools(workflow, workflow.transcript.answering()).ask.execute(
          { text: "Merge now?" },
          call,
        );
      });

      it("keeps the workflow running", () =>
        asked((workflow) => {
          expect(workflow.store.requireWorkflowRow().status).toBe("running");
        }));

      it("sends a question event to the channels", () =>
        asked((workflow) => {
          expect(workflow.posted).toEqual([{ type: "question", text: "Merge now?" }]);
        }));
    });
  });
});
